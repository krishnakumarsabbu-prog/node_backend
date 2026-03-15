import fs from 'fs'
import path from 'path'
import { RepositoryIndex, SearchResult } from './types/index.js'
import { indexRepository } from './indexer/indexer.js'
import { searchFiles, reRankResults } from './retrieval/searcher.js'
import { expandGraphFromSeeds, normalizeFilePath } from './graph/graphBuilder.js'
import { createScopedLogger } from '../../utils/logger'

const logger = createScopedLogger('ai-engine')

let currentIndex: RepositoryIndex | null = null
let indexBuildPromise: Promise<RepositoryIndex> | null = null
let indexedPath: string | null = null

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
  logger.info('Index invalidated')
}
