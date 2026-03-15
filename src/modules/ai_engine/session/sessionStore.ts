import { RepositoryIndex } from '../types/index.js'
import { buildTfIdfIndex, type TfIdfIndex } from '../retrieval/tfidf-embedder.js'
import { createScopedLogger } from '../../../utils/logger.js'

const logger = createScopedLogger('session-store')

const TTL_MS = 2 * 60 * 60 * 1000

interface SessionEntry {
  index: RepositoryIndex
  tfidfIndex: TfIdfIndex
  diskPath: string
  createdAt: number
  lastAccessedAt: number
}

const sessions = new Map<string, SessionEntry>()

setInterval(() => {
  const now = Date.now()
  for (const [sessionId, entry] of sessions.entries()) {
    if (now - entry.lastAccessedAt > TTL_MS) {
      sessions.delete(sessionId)
      logger.info(`Evicted stale session: ${sessionId}`)
    }
  }
}, 10 * 60 * 1000).unref()

export function storeSessionIndex(sessionId: string, index: RepositoryIndex, diskPath: string): void {
  const tfidfIndex = buildTfIdfIndex(index.files)
  sessions.set(sessionId, {
    index,
    tfidfIndex,
    diskPath,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  })
  logger.info(`Stored index for session ${sessionId}: ${index.statistics.totalFiles} files at ${diskPath}`)
}

export function getSessionEntry(sessionId: string): SessionEntry | null {
  const entry = sessions.get(sessionId)
  if (!entry) return null
  entry.lastAccessedAt = Date.now()
  return entry
}

export function getSessionIndex(sessionId: string): RepositoryIndex | null {
  return getSessionEntry(sessionId)?.index ?? null
}

export function getSessionTfIdf(sessionId: string): TfIdfIndex | null {
  return getSessionEntry(sessionId)?.tfidfIndex ?? null
}

export function getSessionDiskPath(sessionId: string): string | null {
  return getSessionEntry(sessionId)?.diskPath ?? null
}

export function updateSessionIndex(sessionId: string, index: RepositoryIndex): void {
  const entry = sessions.get(sessionId)
  if (!entry) {
    logger.warn(`updateSessionIndex: session ${sessionId} not found`)
    return
  }
  entry.index = index
  entry.tfidfIndex = buildTfIdfIndex(index.files)
  entry.lastAccessedAt = Date.now()
  logger.info(`Updated index for session ${sessionId}: ${index.statistics.totalFiles} files`)
}

export function invalidateSession(sessionId: string): void {
  sessions.delete(sessionId)
  logger.info(`Invalidated session: ${sessionId}`)
}

export function listSessions(): string[] {
  return Array.from(sessions.keys())
}
