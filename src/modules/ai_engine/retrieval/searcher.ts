import { FileNode, SearchResult } from '../types/index.js'

interface TokenScore {
  token: string
  count: number
  positions: number[]
}

export function searchFiles(query: string, files: FileNode[]): SearchResult[] {
  const queryTokens = tokenize(query.toLowerCase())

  if (queryTokens.length === 0) {
    return []
  }

  const scoredFiles: SearchResult[] = []

  for (const file of files) {
    const score = calculateFileScore(file, queryTokens)

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

function calculateFileScore(file: FileNode, queryTokens: string[]): { totalScore: number; reasons: string[] } {
  let totalScore = 0
  const reasons: string[] = []

  const fileNameLower = file.name.toLowerCase()
  const pathLower = file.path.toLowerCase()
  const contentLower = file.content.toLowerCase()

  const fileTokens = tokenize(fileNameLower)
  const pathTokens = tokenize(pathLower)
  const contentTokens = tokenize(contentLower)

  for (const queryToken of queryTokens) {
    if (fileNameLower.includes(queryToken)) {
      totalScore += 50
      reasons.push(`Filename contains "${queryToken}"`)
    }

    if (pathLower.includes(queryToken)) {
      totalScore += 20
      reasons.push(`Path contains "${queryToken}"`)
    }

    const exactMatch = fileTokens.includes(queryToken)
    if (exactMatch) {
      totalScore += 30
      reasons.push(`Exact token match in filename: "${queryToken}"`)
    }

    if (pathTokens.includes(queryToken)) {
      totalScore += 10
      reasons.push(`Token in path: "${queryToken}"`)
    }

    const contentMatches = countOccurrences(contentLower, queryToken)
    if (contentMatches > 0) {
      totalScore += Math.min(contentMatches * 2, 20)
      reasons.push(`Found "${queryToken}" ${contentMatches} times in content`)
    }

    for (const symbol of file.symbols) {
      if (symbol.name.toLowerCase().includes(queryToken)) {
        totalScore += 40
        reasons.push(`Symbol match: ${symbol.type} "${symbol.name}"`)
      }
    }

    for (const imp of file.imports) {
      if (imp.toLowerCase().includes(queryToken)) {
        totalScore += 5
        reasons.push(`Import contains "${queryToken}"`)
      }
    }
  }

  const allQueryTokensInFile = queryTokens.every(token =>
    fileNameLower.includes(token) || contentLower.includes(token)
  )
  if (allQueryTokensInFile && queryTokens.length > 1) {
    totalScore += 25
    reasons.push('All query tokens present')
  }

  return { totalScore, reasons }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 0)
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
