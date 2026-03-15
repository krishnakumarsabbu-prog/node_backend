import path from 'path'
import { FileNode, CodeGraph, GraphNode, GraphEdge } from '../types/index.js'

export function buildDependencyGraph(files: FileNode[]): CodeGraph {
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []

  const fileMap = new Map<string, FileNode>()
  for (const file of files) {
    const norm = normalizeFilePath(file.path)
    fileMap.set(norm, file)
    if (file.path !== norm) {
      fileMap.set(file.path, file)
    }
  }

  const edgeSet = new Set<string>()

  const adjacency = new Map<string, string[]>()
  for (const file of files) {
    const norm = normalizeFilePath(file.path)
    nodes.push({
      id: norm,
      type: 'file',
      language: file.language,
      path: norm
    })
    adjacency.set(norm, [])
  }

  for (const file of files) {
    if (!file.imports || file.imports.length === 0) continue

    const currentDir = path.dirname(normalizeFilePath(file.path))
    const fromNorm = normalizeFilePath(file.path)

    for (const importPath of file.imports) {
      const resolvedPath = resolveImport(importPath, currentDir, file.language, fileMap)

      if (resolvedPath) {
        const toNorm = normalizeFilePath(resolvedPath)
        const edgeKey = `${fromNorm}→${toNorm}`

        if (!edgeSet.has(edgeKey)) {
          edgeSet.add(edgeKey)
          edges.push({ from: fromNorm, to: toNorm, type: 'import' })
          const adj = adjacency.get(fromNorm)
          if (adj) adj.push(toNorm)
        }
      }
    }
  }

  return { nodes, edges, _adjacency: adjacency } as any
}

function resolveImport(
  importPath: string,
  currentDir: string,
  language: string,
  fileMap: Map<string, FileNode>
): string | null {
  if (!importPath || !importPath.startsWith('.')) {
    return null
  }

  let candidates: string[] = []

  if (language === 'typescript' || language === 'javascript') {
    let cleanPath = importPath
    if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs') || cleanPath.endsWith('.cjs')) {
      cleanPath = cleanPath.replace(/\.(m|c)?js$/, '')
    }

    const basePath = normalizeFilePath(path.resolve(currentDir, cleanPath))

    candidates = [
      basePath + '.ts',
      basePath + '.tsx',
      basePath + '.js',
      basePath + '.jsx',
      basePath + '.mjs',
      path.join(basePath, 'index.ts'),
      path.join(basePath, 'index.tsx'),
      path.join(basePath, 'index.js'),
      path.join(basePath, 'index.jsx')
    ]
  } else if (language === 'python') {
    const relSegments = importPath.replace(/^\.+/, '').replace(/\./g, '/')
    const basePath = normalizeFilePath(path.resolve(currentDir, relSegments))

    candidates = [
      basePath + '.py',
      path.join(basePath, '__init__.py')
    ]
  } else {
    const basePath = normalizeFilePath(path.resolve(currentDir, importPath))
    candidates = [basePath]
  }

  for (const candidate of candidates) {
    const norm = normalizeFilePath(candidate)
    if (fileMap.has(norm)) {
      return fileMap.get(norm)!.path
    }
  }

  return null
}

export function normalizeFilePath(filePath: string): string {
  const normalized = filePath.split(path.sep).join('/')
  const parts = normalized.split('/')
  const resolved: string[] = []
  for (const part of parts) {
    if (part === '..') {
      resolved.pop()
    } else if (part !== '.') {
      resolved.push(part)
    }
  }
  return resolved.join('/')
}

export function getFileDependencies(filePath: string, graph: CodeGraph): string[] {
  const norm = normalizeFilePath(filePath)
  const adj = (graph as any)._adjacency as Map<string, string[]> | undefined
  if (adj) {
    return adj.get(norm) ?? []
  }

  const dependencies = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.from === norm || edge.from === filePath) {
      dependencies.add(edge.to)
    }
  }
  return Array.from(dependencies)
}

export function getFileDependents(filePath: string, graph: CodeGraph): string[] {
  const norm = normalizeFilePath(filePath)
  const dependents = new Set<string>()

  for (const edge of graph.edges) {
    if (edge.to === norm || edge.to === filePath) {
      dependents.add(edge.from)
    }
  }

  return Array.from(dependents)
}

export function expandGraphFromSeeds(seeds: string[], graph: CodeGraph, maxDepth: number = 2): string[] {
  const normSeeds = seeds.map(normalizeFilePath)
  const result = new Set<string>(normSeeds)
  const queue: Array<{ path: string; depth: number }> = normSeeds.map(s => ({ path: s, depth: 0 }))
  const visited = new Set<string>(normSeeds)

  const outIndex = new Map<string, string[]>()
  const inIndex = new Map<string, string[]>()

  for (const edge of graph.edges) {
    if (!outIndex.has(edge.from)) outIndex.set(edge.from, [])
    outIndex.get(edge.from)!.push(edge.to)

    if (!inIndex.has(edge.to)) inIndex.set(edge.to, [])
    inIndex.get(edge.to)!.push(edge.from)
  }

  while (queue.length > 0) {
    const current = queue.shift()!

    if (current.depth >= maxDepth) continue

    const nextDepth = current.depth + 1

    const deps = outIndex.get(current.path) ?? []
    for (const dep of deps) {
      if (!visited.has(dep)) {
        visited.add(dep)
        result.add(dep)
        queue.push({ path: dep, depth: nextDepth })
      }
    }

    const dependents = inIndex.get(current.path) ?? []
    for (const dep of dependents) {
      if (!visited.has(dep)) {
        visited.add(dep)
        result.add(dep)
        queue.push({ path: dep, depth: nextDepth })
      }
    }
  }

  return Array.from(result)
}
