export interface FileNode {
  path: string
  name: string
  extension: string
  language: string
  content: string
  size: number
  imports: string[]
  symbols: Symbol[]
}

export interface Symbol {
  name: string
  type: 'function' | 'class' | 'method' | 'variable' | 'interface' | 'type' | 'constant'
  line: number
  signature?: string
}

export interface GraphNode {
  id: string
  type: 'file'
  language: string
  path: string
}

export interface GraphEdge {
  from: string
  to: string
  type: 'import' | 'require' | 'reference'
}

export interface CodeGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface RepositoryIndex {
  files: FileNode[]
  graph: CodeGraph
  statistics: IndexStatistics
}

export interface IndexStatistics {
  totalFiles: number
  totalLines: number
  languageDistribution: Record<string, number>
  symbolCount: number
}

export interface SearchResult {
  file: FileNode
  score: number
  matchReasons: string[]
}

export interface LanguageConfig {
  extensions: string[]
  importPatterns: RegExp[]
  symbolPatterns: RegExp[]
}
