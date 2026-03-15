import fs from 'fs'
import path from 'path'
import { FileNode, RepositoryIndex, SearchResult } from './types/index.js'
import { indexRepository } from './indexer/indexer.js'
import { searchFiles, reRankResults } from './retrieval/searcher.js'
import { buildDependencyGraph, expandGraphFromSeeds, normalizeFilePath } from './graph/graphBuilder.js'
import { extractImports } from './languages/importDetector.js'
import { extractSymbols } from './languages/symbolExtractor.js'
import { detectLanguage } from './languages/detector.js'
import { createScopedLogger } from '../../utils/logger'
import { buildTfIdfIndex, searchByEmbedding, expandQueryTokens, type TfIdfIndex } from './retrieval/tfidf-embedder.js'
import {
  storeSessionIndex,
  getSessionEntry,
  getSessionIndex,
  updateSessionIndex,
  invalidateSession,
  listSessions,
} from './session/sessionStore.js'

const logger = createScopedLogger('ai-engine')

let currentIndex: RepositoryIndex | null = null
let indexBuildPromise: Promise<RepositoryIndex> | null = null
let indexedPath: string | null = null
let tfidfIndex: TfIdfIndex | null = null

let patchMutex: Promise<void> = Promise.resolve()

function withPatchLock(fn: () => void): Promise<void> {
  const next = patchMutex.then(() => fn())
  patchMutex = next.catch(() => {})
  return next
}

function canonicalizePath(p: string): string {
  try {
    return path.resolve(p)
  } catch {
    return p
  }
}

export async function buildIndexAsync(repositoryPath: string): Promise<RepositoryIndex> {
  const canonical = canonicalizePath(repositoryPath)

  if (indexedPath === canonical && currentIndex) {
    return currentIndex
  }

  if (indexBuildPromise) {
    return indexBuildPromise
  }

  indexBuildPromise = (async () => {
    try {
      logger.info(`Indexing repository: ${canonical}`)
      const startTime = Date.now()
      const index = indexRepository(canonical)
      const duration = Date.now() - startTime

      const { totalFiles, totalLines, symbolCount, languageDistribution } = index.statistics
      const edges = index.graph.edges.length

      logger.info(`Index complete: ${totalFiles} files, ${totalLines} lines, ${symbolCount} symbols, ${edges} edges in ${duration}ms`)

      const sortedLangs = Object.entries(languageDistribution).sort((a, b) => b[1] - a[1])
      for (const [lang, count] of sortedLangs) {
        logger.debug(`  ${lang}: ${count} files`)
      }

      currentIndex = index
      indexedPath = canonical
      tfidfIndex = buildTfIdfIndex(index.files)
      logger.info(`TF-IDF index built: vocab size ${tfidfIndex.vocab.size}`)
      return index
    } finally {
      indexBuildPromise = null
    }
  })()

  return indexBuildPromise
}

export function buildIndex(repositoryPath: string): RepositoryIndex {
  const canonical = canonicalizePath(repositoryPath)

  if (indexedPath === canonical && currentIndex) {
    logger.info(`Reusing cached index for: ${canonical}`)
    return currentIndex
  }

  logger.info(`Indexing repository: ${canonical}`)

  const startTime = Date.now()
  const index = indexRepository(canonical)
  const duration = Date.now() - startTime

  const { totalFiles, totalLines, symbolCount, languageDistribution } = index.statistics
  const edges = index.graph.edges.length

  logger.info(`Index complete: ${totalFiles} files, ${totalLines} lines, ${symbolCount} symbols, ${edges} edges in ${duration}ms`)

  const sortedLangs = Object.entries(languageDistribution).sort((a, b) => b[1] - a[1])
  for (const [lang, count] of sortedLangs) {
    logger.debug(`  ${lang}: ${count} files`)
  }

  currentIndex = index
  indexedPath = canonical
  tfidfIndex = buildTfIdfIndex(index.files)
  logger.info(`TF-IDF index built: vocab size ${tfidfIndex.vocab.size}`)
  return index
}

export function saveIndex(outputPath: string = 'repository_index.json'): void {
  if (!currentIndex) {
    throw new Error('No index available. Call buildIndex() first.')
  }

  const dir = path.dirname(path.resolve(outputPath))
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  logger.info(`Saving index to ${outputPath}`)
  fs.writeFileSync(outputPath, JSON.stringify(currentIndex, null, 2))
  logger.info('Index saved')
}

export function loadIndex(inputPath: string = 'repository_index.json'): RepositoryIndex {
  logger.info(`Loading index from ${inputPath}`)
  let data: string
  try {
    data = fs.readFileSync(inputPath, 'utf-8')
  } catch (err) {
    throw new Error(`Failed to read index file "${inputPath}": ${err}`)
  }

  let parsed: any
  try {
    parsed = JSON.parse(data)
  } catch (err) {
    throw new Error(`Failed to parse index file "${inputPath}": ${err}`)
  }

  if (!parsed || !Array.isArray(parsed.files) || !parsed.graph || !parsed.statistics) {
    throw new Error(`Index file "${inputPath}" has invalid structure`)
  }

  currentIndex = parsed as RepositoryIndex
  logger.info('Index loaded')
  return currentIndex
}

export function search(query: string, topK: number = 10): SearchResult[] {
  if (!currentIndex) {
    throw new Error('No index available. Call buildIndex() or loadIndex() first.')
  }

  const results = searchFiles(query, currentIndex.files)
  const topResults = results.slice(0, topK)

  logger.info(`Search "${query.substring(0, 60)}": ${results.length} total, returning top ${topResults.length}`)

  return topResults
}

export function searchWithEmbedding(query: string, topK: number = 20, graphDepth: number = 1): string[] {
  if (!currentIndex || !tfidfIndex) {
    logger.warn('searchWithEmbedding called with no index — returning empty results')
    return []
  }

  const expandedTokens = expandQueryTokens(query)
  const expandedQuery = expandedTokens.join(' ')

  const results = searchByEmbedding(expandedQuery, currentIndex.files, tfidfIndex, topK)
  if (results.length === 0) {
    logger.debug(`searchWithEmbedding: no results for query "${query.substring(0, 60)}"`)
    return []
  }

  const reRanked = reRankResults(results, query)
  const seeds = reRanked.slice(0, Math.min(5, reRanked.length)).map(r => normalizeFilePath(r.file.path))

  const expandedFiles = expandGraphFromSeeds(seeds, currentIndex.graph, graphDepth)
  logger.debug(`Embedding graph expansion: ${seeds.length} seeds -> ${expandedFiles.length} files (depth=${graphDepth})`)

  const validPaths = new Set(currentIndex.files.map(f => normalizeFilePath(f.path)))
  return expandedFiles.filter(p => validPaths.has(p))
}

export function searchWithGraph(query: string, topK: number = 5, graphDepth: number = 1): string[] {
  if (!currentIndex) {
    logger.warn('searchWithGraph called with no index — returning empty results')
    return []
  }

  const searchResults = searchFiles(query, currentIndex.files)
  if (searchResults.length === 0) {
    logger.debug(`searchWithGraph: no search results for query "${query.substring(0, 60)}"`)
    return []
  }

  const reRanked = reRankResults(searchResults, query)
  const seeds = reRanked.slice(0, topK).map(r => normalizeFilePath(r.file.path))

  const expandedFiles = expandGraphFromSeeds(seeds, currentIndex.graph, graphDepth)
  logger.debug(`Graph expansion: ${seeds.length} seeds -> ${expandedFiles.length} files (depth=${graphDepth})`)

  const validPaths = new Set(currentIndex.files.map(f => normalizeFilePath(f.path)))
  const filtered = expandedFiles.filter(p => validPaths.has(p))

  if (filtered.length !== expandedFiles.length) {
    logger.debug(`searchWithGraph: filtered ${expandedFiles.length - filtered.length} dangling graph paths`)
  }

  return filtered
}

export function getIndex(): RepositoryIndex | null {
  return currentIndex
}

export function invalidateIndex(): void {
  currentIndex = null
  indexedPath = null
  indexBuildPromise = null
  tfidfIndex = null
  logger.info('Index invalidated')
}

export interface PatchEntry {
  path: string
  content: string
}

export async function buildIndexForSession(sessionId: string, repositoryPath: string): Promise<RepositoryIndex> {
  const canonical = canonicalizePath(repositoryPath)
  logger.info(`Indexing session ${sessionId} at: ${canonical}`)

  const startTime = Date.now()
  const index = indexRepository(canonical)
  const duration = Date.now() - startTime

  const { totalFiles, totalLines, symbolCount } = index.statistics
  logger.info(`Session index complete: ${totalFiles} files, ${totalLines} lines, ${symbolCount} symbols in ${duration}ms`)

  storeSessionIndex(sessionId, index, canonical)
  return index
}

export function searchWithEmbeddingForSession(
  sessionId: string,
  query: string,
  topK: number = 20,
  graphDepth: number = 1,
): string[] {
  const entry = getSessionEntry(sessionId)
  if (!entry) {
    logger.warn(`searchWithEmbeddingForSession: session ${sessionId} not found`)
    return []
  }

  const expandedTokens = expandQueryTokens(query)
  const expandedQuery = expandedTokens.join(' ')

  const results = searchByEmbedding(expandedQuery, entry.index.files, entry.tfidfIndex, topK)
  if (results.length === 0) return []

  const reRanked = reRankResults(results, query)
  const seeds = reRanked.slice(0, Math.min(5, reRanked.length)).map(r => normalizeFilePath(r.file.path))

  const expandedFiles = expandGraphFromSeeds(seeds, entry.index.graph, graphDepth)
  const validPaths = new Set(entry.index.files.map(f => normalizeFilePath(f.path)))
  return expandedFiles.filter(p => validPaths.has(p))
}

export function searchWithGraphForSession(
  sessionId: string,
  query: string,
  topK: number = 5,
  graphDepth: number = 1,
): string[] {
  const entry = getSessionEntry(sessionId)
  if (!entry) {
    logger.warn(`searchWithGraphForSession: session ${sessionId} not found`)
    return []
  }

  const searchResults = searchFiles(query, entry.index.files)
  if (searchResults.length === 0) return []

  const reRanked = reRankResults(searchResults, query)
  const seeds = reRanked.slice(0, topK).map(r => normalizeFilePath(r.file.path))

  const expandedFiles = expandGraphFromSeeds(seeds, entry.index.graph, graphDepth)
  const validPaths = new Set(entry.index.files.map(f => normalizeFilePath(f.path)))
  return expandedFiles.filter(p => validPaths.has(p))
}

export function patchIndexForSession(sessionId: string, changes: PatchEntry[]): void {
  const entry = getSessionEntry(sessionId)
  if (!entry || changes.length === 0) return

  const index = entry.index
  const changedNormPaths = new Set(changes.map(c => normalizeFilePath(c.path)))

  const survivingFiles = index.files.filter(f => !changedNormPaths.has(normalizeFilePath(f.path)))

  const newNodes: FileNode[] = changes
    .filter(c => c.content !== null && c.content !== undefined)
    .map(c => {
      const normPath = normalizeFilePath(c.path)
      const name = normPath.split('/').pop() ?? normPath
      const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
      const language = detectLanguage(name, c.content)

      let imports: string[] = []
      let symbols: ReturnType<typeof extractSymbols> = []

      try { imports = extractImports(c.content, language) } catch { imports = [] }
      try { symbols = extractSymbols(c.content, language) } catch { symbols = [] }

      return {
        path: normPath,
        name,
        extension: ext,
        language,
        content: c.content,
        size: Buffer.byteLength(c.content, 'utf8'),
        imports,
        symbols,
      } satisfies FileNode
    })

  const mergedFiles = [...survivingFiles, ...newNodes]

  let graph
  try {
    graph = buildDependencyGraph(mergedFiles)
  } catch {
    graph = index.graph
  }

  const languageDistribution: Record<string, number> = {}
  let totalLines = 0
  let symbolCount = 0
  for (const f of mergedFiles) {
    languageDistribution[f.language] = (languageDistribution[f.language] || 0) + 1
    totalLines += (f.content.match(/\n/g)?.length ?? 0) + 1
    symbolCount += (f.symbols || []).length
  }

  const updatedIndex: RepositoryIndex = {
    files: mergedFiles,
    graph,
    statistics: { totalFiles: mergedFiles.length, totalLines, languageDistribution, symbolCount },
  }

  updateSessionIndex(sessionId, updatedIndex)
  logger.info(`patchIndexForSession ${sessionId}: ${changes.length} change(s), now ${mergedFiles.length} files`)
}

export { getSessionIndex, invalidateSession, listSessions }

export function patchIndex(changes: PatchEntry[]): Promise<void> {
  if (!currentIndex || changes.length === 0) return Promise.resolve()

  return withPatchLock(() => {
    if (!currentIndex) return

    const startTime = Date.now()

    const changedNormPaths = new Set(
      changes.map(c => normalizeFilePath(c.path))
    )

    const survivingFiles = currentIndex.files.filter(
      f => !changedNormPaths.has(normalizeFilePath(f.path))
    )

    const newNodes: FileNode[] = changes
      .filter(c => c.content !== null && c.content !== undefined)
      .map(c => {
        const normPath = normalizeFilePath(c.path)
        const name = normPath.split('/').pop() ?? normPath
        const ext = name.includes('.') ? '.' + name.split('.').pop()!.toLowerCase() : ''
        const language = detectLanguage(name, c.content)

        let imports: string[] = []
        let symbols: ReturnType<typeof extractSymbols> = []

        try { imports = extractImports(c.content, language) } catch { imports = [] }
        try { symbols = extractSymbols(c.content, language) } catch { symbols = [] }

        return {
          path: normPath,
          name,
          extension: ext,
          language,
          content: c.content,
          size: Buffer.byteLength(c.content, 'utf8'),
          imports,
          symbols,
        } satisfies FileNode
      })

    const mergedFiles = [...survivingFiles, ...newNodes]

    let graph
    try {
      graph = buildDependencyGraph(mergedFiles)
    } catch {
      graph = currentIndex.graph
    }

    const languageDistribution: Record<string, number> = {}
    let totalLines = 0
    let symbolCount = 0
    for (const f of mergedFiles) {
      languageDistribution[f.language] = (languageDistribution[f.language] || 0) + 1
      totalLines += (f.content.match(/\n/g)?.length ?? 0) + 1
      symbolCount += (f.symbols || []).length
    }

    currentIndex = {
      files: mergedFiles,
      graph,
      statistics: {
        totalFiles: mergedFiles.length,
        totalLines,
        languageDistribution,
        symbolCount,
      },
    }

    tfidfIndex = buildTfIdfIndex(mergedFiles)

    const duration = Date.now() - startTime
    logger.info(
      `patchIndex: applied ${changes.length} change(s), index now has ${mergedFiles.length} files, ${graph.edges.length} edges (${duration}ms)`
    )
  })
}
