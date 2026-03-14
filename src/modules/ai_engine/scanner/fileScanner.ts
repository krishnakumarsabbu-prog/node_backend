import fs from 'fs'
import path from 'path'
import { FileNode } from '../types/index.js'
import { detectLanguage } from '../languages/detector.js'

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  'bin',
  '.idea',
  '.vscode',
  'coverage',
  '.next',
  '.nuxt',
  '__pycache__',
  'venv',
  '.env',
  'tmp',
  'temp'
])

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp',
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.a', '.lib',
  '.class', '.jar', '.war',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx',
  '.mp3', '.mp4', '.avi', '.mov', '.wav',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  '.lock', '.log', '.bin', '.dat', '.db', '.sqlite'
])

const MAX_FILE_SIZE = 10 * 1024 * 1024

export function scanRepository(rootPath: string): FileNode[] {
  const files: FileNode[] = []
  const absoluteRoot = path.resolve(rootPath)

  function scanDirectory(dirPath: string) {
    let entries: fs.Dirent[]

    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch (error) {
      console.warn(`Cannot read directory: ${dirPath}`)
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name)

      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
          continue
        }
        scanDirectory(fullPath)
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) {
          continue
        }

        const ext = path.extname(entry.name).toLowerCase()

        if (BINARY_EXTENSIONS.has(ext)) {
          continue
        }

        try {
          const stats = fs.statSync(fullPath)

          if (stats.size > MAX_FILE_SIZE) {
            console.warn(`Skipping large file: ${fullPath}`)
            continue
          }

          const content = fs.readFileSync(fullPath, 'utf-8')
          const language = detectLanguage(entry.name, content)
          const relativePath = path.relative(absoluteRoot, fullPath)

          files.push({
            path: relativePath,
            name: entry.name,
            extension: ext,
            language,
            content,
            size: stats.size,
            imports: [],
            symbols: []
          })
        } catch (error) {
          console.warn(`Cannot read file: ${fullPath}`)
        }
      }
    }
  }

  scanDirectory(absoluteRoot)
  return files
}
