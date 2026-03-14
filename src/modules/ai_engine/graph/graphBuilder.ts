import path from 'path'
import { FileNode, CodeGraph, GraphNode, GraphEdge } from '../types/index.js'

interface ImportResolution {
  fromFile: string
  toFile: string
  importPath: string
}

export function buildDependencyGraph(files: FileNode[]): CodeGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const fileMap = new Map<string, FileNode>()
  files.forEach(file => {
    fileMap.set(file.path, file)
    fileMap.set(normalizeFilePath(file.path), file)
  })

  files.forEach(file => {
    nodes.push({
      id: file.path,
      type: 'file',
      language: file.language,
      path: file.path
    })
  })

  files.forEach(file => {
    if (file.imports.length === 0) return

    const currentDir = path.dirname(file.path)

    for (const importPath of file.imports) {
      const resolvedPath = resolveImport(importPath, currentDir, file.language, fileMap)

      if (resolvedPath && fileMap.has(resolvedPath)) {
        edges.push({
          from: file.path,
          to: resolvedPath,
          type: 'import'
        })
      }
    }
  })

  return { nodes, edges }
}

function resolveImport(
  importPath: string,
  currentDir: string,
  language: string,
  fileMap: Map<string, FileNode>
): string | null {
  if (!importPath.startsWith('.')) {
    return null
  }

  let candidates: string[] = []

  if (language === 'typescript' || language === 'javascript') {
    let cleanPath = importPath
    if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) {
      cleanPath = cleanPath.replace(/\.(m)?js$/, '')
    }

    const basePath = path.join(currentDir, cleanPath)

    candidates = [
      basePath + '.ts',
      basePath + '.tsx',
      basePath + '.js',
      basePath + '.jsx',
      basePath + '.mjs',
      importPath,
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.jsx')
    ]
  } else if (language === 'python') {
    const basePath = path.join(currentDir, importPath.replace(/\./g, '/'))

    candidates = [
      basePath + '.py',
      path.join(basePath, '__init__.py')
    ]
  } else {
    const basePath = path.join(currentDir, importPath)
    candidates = [basePath]
  }

  for (const candidate of candidates) {
    const normalized = normalizeFilePath(candidate)
    if (fileMap.has(normalized)) {
      return fileMap.get(normalized)!.path
    }
  }

  return null
}

function normalizeFilePath(filePath: string): string {
  return filePath.split(path.sep).join('/')
}

export function getFileDependencies(filePath: string, graph: CodeGraph): string[] {
  const dependencies = new Set<string>()

  graph.edges.forEach(edge => {
    if (edge.from === filePath) {
      dependencies.add(edge.to)
    }
  })

  return Array.from(dependencies)
}

export function getFileDependents(filePath: string, graph: CodeGraph): string[] {
  const dependents = new Set<string>()

  graph.edges.forEach(edge => {
    if (edge.to === filePath) {
      dependents.add(edge.from)
    }
  })

  return Array.from(dependents)
}

export function expandGraphFromSeeds(seeds: string[], graph: CodeGraph, maxDepth: number = 2): string[] {
  const result = new Set<string>(seeds)
  const queue: Array<{ path: string; depth: number }> = seeds.map(s => ({ path: s, depth: 0 }))
  const visited = new Set<string>(seeds)

  while (queue.length > 0) {
    const current = queue.shift()!

    if (current.depth >= maxDepth) continue

    graph.edges.forEach(edge => {
      if (edge.from === current.path && !visited.has(edge.to)) {
        result.add(edge.to)
        visited.add(edge.to)
        queue.push({ path: edge.to, depth: current.depth + 1 })
      }

      if (edge.to === current.path && !visited.has(edge.from)) {
        result.add(edge.from)
        visited.add(edge.from)
        queue.push({ path: edge.from, depth: current.depth + 1 })
      }
    })
  }

  return Array.from(result)
}
