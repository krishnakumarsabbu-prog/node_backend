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
    /^[ \t]+def\s+(\w+)\s*\(/gm,
    /^[ \t]+async\s+def\s+(\w+)\s*\(/gm
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

function determineSymbolType(matchedText: string, patternSource: string): Symbol['type'] {
  const src = patternSource
  const text = matchedText

  if (src.includes('class') && /\bclass\b/.test(text)) return 'class'
  if (src.includes('interface') && /\b(?:interface|protocol|trait)\b/.test(text)) return 'interface'
  if (src.includes('type') && /\btype\b/.test(text)) return 'type'
  if (src.includes('const') && /\bconst\b/.test(text)) return 'constant'
  if (src.includes('enum') && /\benum\b/.test(text)) return 'type'
  if (src.includes('struct') && /\bstruct\b/.test(text)) return 'class'
  if (src.includes('namespace') && /\bnamespace\b/.test(text)) return 'class'
  if (src.includes('module') && /\bmodule\b/.test(text)) return 'class'
  if (src.includes('object') && /\bobject\b/.test(text)) return 'class'
  if (src.includes('function') || src.includes('def') || src.includes('fn') || src.includes('func') || src.includes('fun')) return 'function'

  return 'function'
}

export function extractSymbols(content: string, language: string): Symbol[] {
  const patterns = SYMBOL_PATTERNS[language] || []
  const symbols: Symbol[] = []
  const seenKeys = new Set<string>()

  for (const pattern of patterns) {
    const cloned = new RegExp(pattern.source, pattern.flags)
    cloned.lastIndex = 0

    let match: RegExpExecArray | null
    while ((match = cloned.exec(content)) !== null) {
      const symbolName = match[1]
      if (!symbolName) continue

      const beforeMatch = content.substring(0, match.index)
      const lineNumber = beforeMatch.split('\n').length

      const symbolType = determineSymbolType(match[0], cloned.source)

      const dedupeKey = `${symbolName}:${symbolType}:${lineNumber}`
      if (seenKeys.has(dedupeKey)) continue
      seenKeys.add(dedupeKey)

      symbols.push({
        name: symbolName,
        type: symbolType,
        line: lineNumber,
        signature: match[0].trim().split('\n')[0].slice(0, 200)
      })
    }
  }

  return symbols
}
