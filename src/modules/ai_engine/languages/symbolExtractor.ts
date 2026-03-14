import { Symbol } from '../types/index.js'

const SYMBOL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /(?:export\s+)?function\s+(\w+)\s*[<(]/gm,
    /(?:export\s+)?class\s+(\w+)/gm,
    /(?:export\s+)?interface\s+(\w+)/gm,
    /(?:export\s+)?type\s+(\w+)/gm,
    /(?:export\s+)?const\s+(\w+)\s*=/gm,
    /(?:async\s+)?(\w+)\s*:\s*(?:async\s+)?\([^)]*\)\s*=>/gm,
    /(\w+)\s*\([^)]*\)\s*:\s*\w+\s*\{/gm
  ],
  javascript: [
    /(?:export\s+)?function\s+(\w+)\s*\(/gm,
    /(?:export\s+)?class\s+(\w+)/gm,
    /(?:export\s+)?const\s+(\w+)\s*=/gm,
    /(?:async\s+)?(\w+)\s*:\s*(?:async\s+)?(?:function\s*)?\([^)]*\)\s*=>/gm,
    /(\w+)\s*\([^)]*\)\s*\{/gm
  ],
  python: [
    /^def\s+(\w+)\s*\(/gm,
    /^async\s+def\s+(\w+)\s*\(/gm,
    /^class\s+(\w+)/gm,
    /^\s{4}def\s+(\w+)\s*\(/gm
  ],
  java: [
    /(?:public|private|protected)?\s*(?:static\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)\s*\{/gm,
    /(?:public|private|protected)?\s*class\s+(\w+)/gm,
    /(?:public|private|protected)?\s*interface\s+(\w+)/gm,
    /(?:public|private|protected)?\s*enum\s+(\w+)/gm
  ],
  go: [
    /func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(/gm,
    /type\s+(\w+)\s+struct/gm,
    /type\s+(\w+)\s+interface/gm,
    /type\s+(\w+)\s+\w+/gm
  ],
  rust: [
    /fn\s+(\w+)\s*[<(]/gm,
    /pub\s+fn\s+(\w+)\s*[<(]/gm,
    /struct\s+(\w+)/gm,
    /pub\s+struct\s+(\w+)/gm,
    /enum\s+(\w+)/gm,
    /trait\s+(\w+)/gm,
    /impl\s+(?:\w+\s+for\s+)?(\w+)/gm
  ],
  cpp: [
    /(?:void|int|float|double|char|bool|auto|long|short)\s+(\w+)\s*\(/gm,
    /class\s+(\w+)/gm,
    /struct\s+(\w+)/gm,
    /namespace\s+(\w+)/gm
  ],
  c: [
    /(?:void|int|float|double|char|bool|long|short)\s+(\w+)\s*\(/gm,
    /struct\s+(\w+)/gm,
    /typedef\s+(?:struct|enum)\s+(\w+)/gm
  ],
  csharp: [
    /(?:public|private|protected|internal)?\s*(?:static\s+)?(?:async\s+)?(?:\w+\s+)?(\w+)\s*\([^)]*\)/gm,
    /(?:public|private|protected|internal)?\s*class\s+(\w+)/gm,
    /(?:public|private|protected|internal)?\s*interface\s+(\w+)/gm,
    /(?:public|private|protected|internal)?\s*enum\s+(\w+)/gm
  ],
  php: [
    /function\s+(\w+)\s*\(/gm,
    /class\s+(\w+)/gm,
    /interface\s+(\w+)/gm,
    /trait\s+(\w+)/gm
  ],
  ruby: [
    /def\s+(\w+)/gm,
    /class\s+(\w+)/gm,
    /module\s+(\w+)/gm
  ],
  kotlin: [
    /fun\s+(\w+)\s*[<(]/gm,
    /class\s+(\w+)/gm,
    /interface\s+(\w+)/gm,
    /object\s+(\w+)/gm
  ],
  swift: [
    /func\s+(\w+)\s*[<(]/gm,
    /class\s+(\w+)/gm,
    /struct\s+(\w+)/gm,
    /protocol\s+(\w+)/gm,
    /enum\s+(\w+)/gm
  ],
  scala: [
    /def\s+(\w+)\s*[<(]/gm,
    /class\s+(\w+)/gm,
    /object\s+(\w+)/gm,
    /trait\s+(\w+)/gm
  ]
}

function determineSymbolType(match: string, pattern: string): Symbol['type'] {
  if (pattern.includes('class')) return 'class'
  if (pattern.includes('interface') || pattern.includes('trait') || pattern.includes('protocol')) return 'interface'
  if (pattern.includes('function') || pattern.includes('def') || pattern.includes('fn')) return 'function'
  if (pattern.includes('const')) return 'constant'
  if (pattern.includes('type') || pattern.includes('typedef')) return 'type'
  return 'function'
}

export function extractSymbols(content: string, language: string): Symbol[] {
  const patterns = SYMBOL_PATTERNS[language] || []
  const symbols: Symbol[] = []
  const seenSymbols = new Set<string>()
  const lines = content.split('\n')

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    const matches = content.matchAll(pattern)

    for (const match of matches) {
      if (match[1] && match.index !== undefined) {
        const symbolName = match[1]

        if (seenSymbols.has(symbolName)) {
          continue
        }

        const beforeMatch = content.substring(0, match.index)
        const lineNumber = beforeMatch.split('\n').length

        const symbolType = determineSymbolType(match[0], pattern.source)

        symbols.push({
          name: symbolName,
          type: symbolType,
          line: lineNumber,
          signature: match[0].trim().split('\n')[0]
        })

        seenSymbols.add(symbolName)
      }
    }
  }

  return symbols
}
