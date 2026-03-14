const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.java': 'java',
  '.go': 'go',
  '.rs': 'rust',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c': 'c',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.rb': 'ruby',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.swift': 'swift',
  '.scala': 'scala',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.json': 'json',
  '.xml': 'xml',
  '.md': 'markdown',
  '.txt': 'text',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.r': 'r',
  '.m': 'objective-c',
  '.dart': 'dart',
  '.lua': 'lua',
  '.pl': 'perl',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.clj': 'clojure',
  '.erl': 'erlang',
  '.hrl': 'erlang',
  '.ml': 'ocaml',
  '.hs': 'haskell',
  '.elm': 'elm',
  '.tf': 'terraform',
  '.groovy': 'groovy',
  '.gradle': 'gradle'
}

export function detectLanguage(filename: string, content: string): string {
  const ext = filename.toLowerCase().split('.').pop()

  if (ext) {
    const extWithDot = '.' + ext
    if (LANGUAGE_MAP[extWithDot]) {
      return LANGUAGE_MAP[extWithDot]
    }
  }

  if (filename === 'Dockerfile' || filename === 'Dockerfile.dev') {
    return 'docker'
  }

  if (filename === 'Makefile' || filename === 'makefile') {
    return 'makefile'
  }

  if (content.startsWith('#!/')) {
    const shebang = content.split('\n')[0]
    if (shebang.includes('python')) return 'python'
    if (shebang.includes('node')) return 'javascript'
    if (shebang.includes('bash') || shebang.includes('sh')) return 'shell'
    if (shebang.includes('ruby')) return 'ruby'
  }

  return 'unknown'
}

export function getSupportedLanguages(): string[] {
  return Array.from(new Set(Object.values(LANGUAGE_MAP)))
}
