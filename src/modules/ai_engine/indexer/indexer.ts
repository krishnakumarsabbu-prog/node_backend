import { FileNode, RepositoryIndex, IndexStatistics } from '../types/index.js'
import { scanRepository } from '../scanner/fileScanner.js'
import { extractImports } from '../languages/importDetector.js'
import { extractSymbols } from '../languages/symbolExtractor.js'
import { buildDependencyGraph } from '../graph/graphBuilder.js'

export function indexRepository(rootPath: string): RepositoryIndex {
  console.log('Scanning repository...')
  const files = scanRepository(rootPath)
  console.log(`Found ${files.length} files`)

  console.log('Extracting imports and symbols...')
  files.forEach((file, index) => {
    if ((index + 1) % 100 === 0) {
      console.log(`Processed ${index + 1}/${files.length} files`)
    }

    try {
      file.imports = extractImports(file.content, file.language)
      file.symbols = extractSymbols(file.content, file.language)
    } catch (error) {
      console.warn(`Error processing file ${file.path}:`, error)
    }
  })

  console.log('Building dependency graph...')
  const graph = buildDependencyGraph(files)
  console.log(`Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`)

  console.log('Computing statistics...')
  const statistics = computeStatistics(files)

  return {
    files,
    graph,
    statistics
  }
}

function computeStatistics(files: FileNode[]): IndexStatistics {
  const languageDistribution: Record<string, number> = {}
  let totalLines = 0
  let symbolCount = 0

  files.forEach(file => {
    languageDistribution[file.language] = (languageDistribution[file.language] || 0) + 1

    const lines = file.content.split('\n').length
    totalLines += lines

    symbolCount += file.symbols.length
  })

  return {
    totalFiles: files.length,
    totalLines,
    languageDistribution,
    symbolCount
  }
}
