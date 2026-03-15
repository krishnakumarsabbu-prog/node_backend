import { FileNode, SearchResult } from '../types/index.js'

interface TokenScore {
  token: string
  count: number
  positions: number[]
}

const IDF_SMOOTHING = 1.0
const BM25_K1 = 1.5
const BM25_B = 0.75

function buildIdf(query: string[], files: FileNode[]): Map<string, number> {
  const df = new Map<string, number>()
  const N = files.length

  for (const token of query) {
    let count = 0
    for (const file of files) {
      const content = (file.content + ' ' + file.name + ' ' + file.symbols.map(s => s.name).join(' ')).toLowerCase()
      if (content.includes(token)) count++
    }
    df.set(token, count)
  }

  const idf = new Map<string, number>()
  for (const [token, count] of df.entries()) {
    idf.set(token, Math.log((N - count + IDF_SMOOTHING) / (count + IDF_SMOOTHING) + 1))
  }
  return idf
}

function bm25Score(tf: number, idf: number, docLength: number, avgDocLength: number): number {
  const numerator = tf * (BM25_K1 + 1)
  const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / Math.max(1, avgDocLength)))
  return idf * (numerator / denominator)
}

export function searchFiles(query: string, files: FileNode[]): SearchResult[] {
  const queryTokens = tokenize(query.toLowerCase())

  if (queryTokens.length === 0 || files.length === 0) {
    return []
  }

  const avgDocLength = files.reduce((acc, f) => acc + tokenize(f.content.toLowerCase()).length, 0) / files.length
  const idf = buildIdf(queryTokens, files)

  const scoredFiles: SearchResult[] = []

  for (const file of files) {
    const score = calculateFileScore(file, queryTokens, idf, avgDocLength)

    if (score.totalScore > 0) {
      scoredFiles.push({
        file,
        score: score.totalScore,
        matchReasons: score.reasons
      })
    }
  }

  scoredFiles.sort((a, b) => b.score - a.score)

  return scoredFiles
}

function calculateFileScore(
  file: FileNode,
  queryTokens: string[],
  idf: Map<string, number>,
  avgDocLength: number
): { totalScore: number; reasons: string[] } {
  let totalScore = 0
  const reasons: string[] = []

  const fileNameLower = file.name.toLowerCase()
  const pathLower = file.path.toLowerCase()
  const contentLower = file.content.toLowerCase()

  const contentTokens = tokenize(contentLower)
  const docLength = contentTokens.length

  const tfMap = new Map<string, number>()
  for (const t of contentTokens) {
    tfMap.set(t, (tfMap.get(t) || 0) + 1)
  }

  for (const queryToken of queryTokens) {
    const tokenIdf = idf.get(queryToken) || 0

    if (fileNameLower.includes(queryToken)) {
      totalScore += 50 * (1 + tokenIdf)
      reasons.push(`Filename contains "${queryToken}"`)
    }

    const fileNameTokens = tokenize(fileNameLower)
    if (fileNameTokens.includes(queryToken)) {
      totalScore += 30 * (1 + tokenIdf)
      reasons.push(`Exact token match in filename: "${queryToken}"`)
    }

    if (pathLower.includes(queryToken)) {
      totalScore += 20
      reasons.push(`Path contains "${queryToken}"`)
    }

    const pathTokens = tokenize(pathLower)
    if (pathTokens.includes(queryToken)) {
      totalScore += 10
      reasons.push(`Token in path: "${queryToken}"`)
    }

    const tf = tfMap.get(queryToken) || 0
    if (tf > 0) {
      const bm25 = bm25Score(tf, tokenIdf, docLength, avgDocLength)
      totalScore += bm25 * 15
      reasons.push(`BM25 match "${queryToken}" (tf=${tf}, score=${bm25.toFixed(2)})`)
    }

    for (const symbol of file.symbols) {
      const symbolLower = symbol.name.toLowerCase()
      if (symbolLower.includes(queryToken)) {
        const exactSymbolMatch = symbolLower === queryToken
        totalScore += exactSymbolMatch ? 60 * (1 + tokenIdf) : 40 * (1 + tokenIdf * 0.5)
        reasons.push(`Symbol match: ${symbol.type} "${symbol.name}"`)
      }
    }

    for (const imp of file.imports) {
      if (imp.toLowerCase().includes(queryToken)) {
        totalScore += 5 * (1 + tokenIdf * 0.3)
        reasons.push(`Import contains "${queryToken}"`)
      }
    }
  }

  const allQueryTokensInFile = queryTokens.every(token =>
    fileNameLower.includes(token) || contentLower.includes(token)
  )
  if (allQueryTokensInFile && queryTokens.length > 1) {
    totalScore += 25 * queryTokens.length
    reasons.push('All query tokens present (completeness bonus)')
  }

  const highValuePaths = ['/components/', '/pages/', '/routes/', '/api/', '/services/', '/hooks/', '/lib/', '/utils/']
  for (const hvp of highValuePaths) {
    if (pathLower.includes(hvp)) {
      totalScore += 5
      break
    }
  }

  if (/index\.(ts|tsx|js|jsx)$/.test(file.path)) {
    totalScore += 10
  }

  return { totalScore, reasons }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1)
}

function countOccurrences(text: string, substring: string): number {
  let count = 0
  let position = 0

  while ((position = text.indexOf(substring, position)) !== -1) {
    count++
    position += substring.length
  }

  return count
}

export function searchBySymbol(symbolName: string, files: FileNode[]): FileNode[] {
  const results: FileNode[] = []

  for (const file of files) {
    const hasSymbol = file.symbols.some(symbol =>
      symbol.name.toLowerCase().includes(symbolName.toLowerCase())
    )

    if (hasSymbol) {
      results.push(file)
    }
  }

  return results
}

export function searchByLanguage(language: string, files: FileNode[]): FileNode[] {
  return files.filter(file => file.language === language)
}

export function searchByExtension(extension: string, files: FileNode[]): FileNode[] {
  return files.filter(file => file.extension === extension)
}

export function reRankResults(results: SearchResult[], query: string): SearchResult[] {
  if (results.length <= 1) return results

  const queryTokens = tokenize(query.toLowerCase())

  const reScored = results.map(result => {
    let boost = 0

    const pathParts = result.file.path.toLowerCase().split(/[/._-]/)
    const queryTokensInPath = queryTokens.filter(t => pathParts.some(p => p.includes(t)))
    boost += queryTokensInPath.length * 8

    const symbolMatchCount = result.file.symbols.filter(s =>
      queryTokens.some(t => s.name.toLowerCase().includes(t))
    ).length
    if (symbolMatchCount > 0) boost += symbolMatchCount * 12

    const isTestFile = /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(result.file.path)
    if (isTestFile) boost -= 15

    const isTypeFile = /\.d\.ts$/.test(result.file.path)
    if (isTypeFile) boost -= 10

    return { ...result, score: result.score + boost }
  })

  reScored.sort((a, b) => b.score - a.score)
  return reScored
}
