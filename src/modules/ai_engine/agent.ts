import fs from 'fs'
import { RepositoryIndex, SearchResult } from './types/index.js'
import { indexRepository } from './indexer/indexer.js'
import { searchFiles } from './retrieval/searcher.js'
import { expandGraphFromSeeds } from './graph/graphBuilder.js'
import { createScopedLogger } from '../../utils/logger'

const logger = createScopedLogger('ai-engine')

let currentIndex: RepositoryIndex | null = null

export function buildIndex(repositoryPath: string): RepositoryIndex {
  logger.info(`Indexing repository: ${repositoryPath}`)

  const startTime = Date.now()
  currentIndex = indexRepository(repositoryPath)
  const duration = Date.now() - startTime

  const { totalFiles, totalLines, symbolCount, languageDistribution } = currentIndex.statistics
  const edges = currentIndex.graph.edges.length

  logger.info(`Index complete: ${totalFiles} files, ${totalLines} lines, ${symbolCount} symbols, ${edges} edges in ${duration}ms`)

  const sortedLangs = Object.entries(languageDistribution).sort((a, b) => b[1] - a[1])
  for (const [lang, count] of sortedLangs) {
    logger.debug(`  ${lang}: ${count} files`)
  }

  return currentIndex
}

export function saveIndex(outputPath: string = 'repository_index.json'): void {
  if (!currentIndex) {
    throw new Error('No index available. Call buildIndex() first.')
  }

  logger.info(`Saving index to ${outputPath}`)
  fs.writeFileSync(outputPath, JSON.stringify(currentIndex, null, 2))
  logger.info('Index saved')
}

export function loadIndex(inputPath: string = 'repository_index.json'): RepositoryIndex {
  logger.info(`Loading index from ${inputPath}`)
  const data = fs.readFileSync(inputPath, 'utf-8')
  currentIndex = JSON.parse(data)
  logger.info('Index loaded')
  return currentIndex!
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
    throw new Error('No index available. Call buildIndex() or loadIndex() first.')
  }

  const searchResults = searchFiles(query, currentIndex.files)
  const seeds = searchResults.slice(0, topK).map(r => r.file.path)

  if (seeds.length === 0) {
    return []
  }

  const expandedFiles = expandGraphFromSeeds(seeds, currentIndex.graph, graphDepth)
  logger.debug(`Graph expansion: ${seeds.length} seeds -> ${expandedFiles.length} files`)

  return expandedFiles
}

export function getIndex(): RepositoryIndex | null {
  return currentIndex
}
