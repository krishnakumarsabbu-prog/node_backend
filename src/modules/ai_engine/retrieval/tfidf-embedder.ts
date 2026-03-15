import { FileNode, SearchResult } from '../types/index.js'

const MIN_TOKEN_LENGTH = 2
const MAX_VOCAB_SIZE = 20000

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([a-zA-Z])(\d)/g, '$1 $2')
    .replace(/(\d)([a-zA-Z])/g, '$1 $2')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= MIN_TOKEN_LENGTH)
}

function buildFileText(file: FileNode): string {
  const symbolNames = (file.symbols || []).map(s => s.name).join(' ')
  const imports = (file.imports || []).join(' ')
  const pathParts = file.path.replace(/[/._-]/g, ' ')
  return `${file.name} ${pathParts} ${symbolNames} ${imports} ${file.content}`.toLowerCase()
}

export interface TfIdfIndex {
  vocab: Map<string, number>
  idf: Float64Array
  docVectors: Float32Array[]
  filePaths: string[]
}

export function buildTfIdfIndex(files: FileNode[]): TfIdfIndex {
  const N = files.length
  if (N === 0) {
    return { vocab: new Map(), idf: new Float64Array(0), docVectors: [], filePaths: [] }
  }

  const dfMap = new Map<string, number>()
  const tokenizedDocs: string[][] = []

  for (const file of files) {
    const tokens = tokenize(buildFileText(file))
    const uniqueTokens = new Set(tokens)
    tokenizedDocs.push(tokens)
    for (const t of uniqueTokens) {
      dfMap.set(t, (dfMap.get(t) || 0) + 1)
    }
  }

  const sortedByDf = [...dfMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_VOCAB_SIZE)

  const vocab = new Map<string, number>()
  for (const [term] of sortedByDf) {
    vocab.set(term, vocab.size)
  }

  const V = vocab.size
  const idf = new Float64Array(V)
  for (const [term, idx] of vocab) {
    const df = dfMap.get(term) || 0
    idf[idx] = Math.log((N + 1) / (df + 1)) + 1
  }

  const docVectors: Float32Array[] = []
  for (let i = 0; i < files.length; i++) {
    const tokens = tokenizedDocs[i]
    const tfMap = new Map<string, number>()
    for (const t of tokens) {
      if (vocab.has(t)) tfMap.set(t, (tfMap.get(t) || 0) + 1)
    }

    const vec = new Float32Array(V)
    let norm = 0
    for (const [term, tf] of tfMap) {
      const idx = vocab.get(term)!
      const tfidf = (tf / Math.max(1, tokens.length)) * idf[idx]
      vec[idx] = tfidf
      norm += tfidf * tfidf
    }

    const sqrtNorm = Math.sqrt(norm)
    if (sqrtNorm > 0) {
      for (let j = 0; j < V; j++) vec[j] /= sqrtNorm
    }

    docVectors.push(vec)
  }

  return {
    vocab,
    idf,
    docVectors,
    filePaths: files.map(f => f.path),
  }
}

function buildQueryVector(query: string, vocab: Map<string, number>, idf: Float64Array): Float32Array {
  const V = vocab.size
  const tokens = tokenize(query)
  const tfMap = new Map<string, number>()
  for (const t of tokens) {
    if (vocab.has(t)) tfMap.set(t, (tfMap.get(t) || 0) + 1)
  }

  const vec = new Float32Array(V)
  let norm = 0
  for (const [term, tf] of tfMap) {
    const idx = vocab.get(term)!
    const tfidf = (tf / Math.max(1, tokens.length)) * idf[idx]
    vec[idx] = tfidf
    norm += tfidf * tfidf
  }

  const sqrtNorm = Math.sqrt(norm)
  if (sqrtNorm > 0) {
    for (let j = 0; j < V; j++) vec[j] /= sqrtNorm
  }

  return vec
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

export function searchByEmbedding(
  query: string,
  files: FileNode[],
  index: TfIdfIndex,
  topK: number = 20,
  minScore: number = 0.05
): SearchResult[] {
  if (!query || files.length === 0 || index.vocab.size === 0) return []

  const qVec = buildQueryVector(query, index.vocab, index.idf)

  const hasNonZero = qVec.some(v => v !== 0)
  if (!hasNonZero) return []

  const scored: Array<{ fileIdx: number; score: number }> = []

  for (let i = 0; i < index.docVectors.length; i++) {
    const score = cosineSimilarity(qVec, index.docVectors[i])
    if (score >= minScore) {
      scored.push({ fileIdx: i, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)

  return scored.slice(0, topK).map(({ fileIdx, score }) => ({
    file: files[fileIdx],
    score: score * 100,
    matchReasons: [`TF-IDF cosine similarity: ${score.toFixed(4)}`],
  }))
}

export function expandQueryTokens(query: string): string[] {
  const tokens = tokenize(query)
  const expanded = new Set<string>(tokens)

  for (const token of tokens) {
    if (token.length > 5) {
      expanded.add(token.slice(0, -2))
      expanded.add(token.slice(0, -3))
    }
  }

  const synonymMap: Record<string, string[]> = {
    color: ['colour', 'hue', 'shade', 'theme'],
    btn: ['button'],
    button: ['btn'],
    auth: ['authentication', 'login', 'signin', 'session'],
    login: ['auth', 'signin', 'session'],
    modal: ['dialog', 'popup', 'overlay'],
    api: ['endpoint', 'route', 'handler'],
    route: ['api', 'endpoint', 'path'],
    style: ['css', 'theme', 'color', 'design'],
    css: ['style', 'theme'],
    config: ['configuration', 'settings', 'options'],
    settings: ['config', 'configuration', 'options'],
    user: ['account', 'profile', 'member'],
    profile: ['user', 'account'],
    error: ['exception', 'fault', 'bug', 'issue'],
    fix: ['repair', 'resolve', 'patch'],
    add: ['create', 'insert', 'new'],
    delete: ['remove', 'destroy'],
    update: ['edit', 'modify', 'change'],
    search: ['query', 'find', 'filter'],
    form: ['input', 'field', 'validation'],
  }

  for (const token of tokens) {
    const syns = synonymMap[token]
    if (syns) for (const s of syns) expanded.add(s)
  }

  return [...expanded]
}
