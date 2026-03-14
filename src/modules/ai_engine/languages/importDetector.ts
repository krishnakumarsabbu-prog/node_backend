const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(['"]([^'"]+)['"]\)/g,
    /import\s*\(['"]([^'"]+)['"]\)/g,
    /export\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g
  ],
  javascript: [
    /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\s*\(['"]([^'"]+)['"]\)/g,
    /import\s*\(['"]([^'"]+)['"]\)/g,
    /export\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g
  ],
  python: [
    /^import\s+([\w.]+)/gm,
    /^from\s+([\w.]+)\s+import/gm
  ],
  java: [
    /import\s+([\w.]+);/g,
    /import\s+static\s+([\w.]+);/g
  ],
  go: [
    /import\s+['"]([^'"]+)['"]/g,
    /import\s+\(([\s\S]*?)\)/g
  ],
  rust: [
    /use\s+([\w:]+)/g,
    /extern\s+crate\s+(\w+)/g
  ],
  cpp: [
    /#include\s+[<"]([^>"]+)[>"]/g
  ],
  c: [
    /#include\s+[<"]([^>"]+)[>"]/g
  ],
  csharp: [
    /using\s+([\w.]+);/g
  ],
  php: [
    /require\s*\(?['"]([^'"]+)['"]\)?;/g,
    /require_once\s*\(?['"]([^'"]+)['"]\)?;/g,
    /include\s*\(?['"]([^'"]+)['"]\)?;/g,
    /include_once\s*\(?['"]([^'"]+)['"]\)?;/g,
    /use\s+([\w\\]+);/g
  ],
  ruby: [
    /require\s+['"]([^'"]+)['"]/g,
    /require_relative\s+['"]([^'"]+)['"]/g
  ],
  kotlin: [
    /import\s+([\w.]+)/g
  ],
  swift: [
    /import\s+(\w+)/g
  ],
  scala: [
    /import\s+([\w.]+)/g
  ]
}

export function extractImports(content: string, language: string): string[] {
  const patterns = IMPORT_PATTERNS[language] || []
  const imports = new Set<string>()

  for (const pattern of patterns) {
    const matches = content.matchAll(pattern)

    for (const match of matches) {
      if (match[1]) {
        let importPath = match[1].trim()

        if (language === 'go' && importPath.includes('\n')) {
          const lines = importPath.split('\n')
          lines.forEach(line => {
            const cleaned = line.trim().replace(/['"]/g, '')
            if (cleaned && !cleaned.startsWith('//')) {
              imports.add(cleaned)
            }
          })
        } else {
          importPath = importPath.split(/\s+/)[0]
          imports.add(importPath)
        }
      }
    }
  }

  return Array.from(imports)
}

export function resolveImportPath(importPath: string, currentFilePath: string, language: string): string | null {
  if (!importPath) return null

  if (importPath.startsWith('.')) {
    return importPath
  }

  if (language === 'typescript' || language === 'javascript') {
    if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
      return null
    }
  }

  return importPath
}
