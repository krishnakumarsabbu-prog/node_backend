import fs from 'fs'
import { RepositoryIndex, SearchResult } from './types/index.js'
import { indexRepository } from './indexer/indexer.js'
import { searchFiles } from './retrieval/searcher.js'
import { expandGraphFromSeeds } from './graph/graphBuilder.js'

let currentIndex: RepositoryIndex | null = null

export function buildIndex(repositoryPath: string): RepositoryIndex {
  console.log(`\n=== Indexing Repository: ${repositoryPath} ===\n`)

  const startTime = Date.now()
  currentIndex = indexRepository(repositoryPath)
  const duration = Date.now() - startTime

  console.log('\n=== Index Complete ===')
  console.log(`Total Files: ${currentIndex.statistics.totalFiles}`)
  console.log(`Total Lines: ${currentIndex.statistics.totalLines}`)
  console.log(`Total Symbols: ${currentIndex.statistics.symbolCount}`)
  console.log(`Graph Edges: ${currentIndex.graph.edges.length}`)
  console.log(`Duration: ${duration}ms`)

  console.log('\nLanguage Distribution:')
  const sortedLangs = Object.entries(currentIndex.statistics.languageDistribution)
    .sort((a, b) => b[1] - a[1])
  sortedLangs.forEach(([lang, count]) => {
    console.log(`  ${lang}: ${count} files`)
  })

  return currentIndex
}

export function saveIndex(outputPath: string = 'repository_index.json'): void {
  if (!currentIndex) {
    throw new Error('No index available. Call buildIndex() first.')
  }

  console.log(`\nSaving index to ${outputPath}...`)
  fs.writeFileSync(outputPath, JSON.stringify(currentIndex, null, 2))
  console.log('Index saved successfully.')
}

export function loadIndex(inputPath: string = 'repository_index.json'): RepositoryIndex {
  console.log(`Loading index from ${inputPath}...`)
  const data = fs.readFileSync(inputPath, 'utf-8')
  currentIndex = JSON.parse(data)
  console.log('Index loaded successfully.')
  return currentIndex!
}

export function search(query: string, topK: number = 10): SearchResult[] {
  if (!currentIndex) {
    throw new Error('No index available. Call buildIndex() or loadIndex() first.')
  }

  console.log(`\n=== Searching for: "${query}" ===\n`)

  const results = searchFiles(query, currentIndex.files)
  const topResults = results.slice(0, topK)

  console.log(`Found ${results.length} matching files. Showing top ${topResults.length}:\n`)

  topResults.forEach((result, index) => {
    console.log(`${index + 1}. ${result.file.path} (score: ${result.score})`)
    console.log(`   Language: ${result.file.language}`)
    console.log(`   Symbols: ${result.file.symbols.length}`)
    console.log(`   Reasons: ${result.matchReasons.slice(0, 3).join(', ')}`)
    console.log()
  })

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

  console.log(`\n=== Graph Expansion ===`)
  console.log(`Seeds: ${seeds.length}`)
  console.log(`Expanded to: ${expandedFiles.length} files\n`)

  return expandedFiles
}

export function getIndex(): RepositoryIndex | null {
  return currentIndex
}
