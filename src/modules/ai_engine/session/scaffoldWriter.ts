import fs from 'fs'
import path from 'path'
import { createScopedLogger } from '../../../utils/logger.js'

const logger = createScopedLogger('scaffold-writer')

const PROJECTS_ROOT = process.env.PROJECTS_ROOT || '/tmp/projects'

export function getSessionDiskRoot(): string {
  return PROJECTS_ROOT
}

export function getSessionPath(sessionId: string): string {
  return path.join(PROJECTS_ROOT, sessionId)
}

export function writeScaffoldToDisk(sessionId: string, files: Record<string, string>): string {
  const sessionPath = getSessionPath(sessionId)

  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true })
    logger.info(`Cleared existing scaffold at ${sessionPath}`)
  }

  fs.mkdirSync(sessionPath, { recursive: true })

  let writtenCount = 0
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(sessionPath, relativePath)
    const dir = path.dirname(absolutePath)

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(absolutePath, content, 'utf-8')
    writtenCount++
  }

  logger.info(`Wrote ${writtenCount} scaffold files for session ${sessionId} at ${sessionPath}`)
  return sessionPath
}

export function writeFileToDisk(sessionId: string, relativePath: string, content: string): string {
  const sessionPath = getSessionPath(sessionId)
  const absolutePath = path.join(sessionPath, relativePath)
  const dir = path.dirname(absolutePath)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  fs.writeFileSync(absolutePath, content, 'utf-8')
  logger.debug(`Wrote file ${relativePath} for session ${sessionId}`)
  return absolutePath
}

export function sessionPathExists(sessionId: string): boolean {
  return fs.existsSync(getSessionPath(sessionId))
}

export function cleanupSession(sessionId: string): void {
  const sessionPath = getSessionPath(sessionId)
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true, force: true })
    logger.info(`Cleaned up disk for session ${sessionId}`)
  }
}
