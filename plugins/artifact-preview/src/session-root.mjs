import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function sameHeaderIdentity(left, right) {
  return left.id === right.id
    && left.createdAt === right.createdAt
    && left.cwd === right.cwd
}

function platformAbsolute(candidate) {
  if (process.platform === 'win32') return path.win32.isAbsolute(candidate)
  return path.posix.isAbsolute(candidate)
}

export async function resolveSessionRoot({ sessions, sessionPersistence }, sessionId) {
  const live = sessions.get(sessionId)?.header
  const persisted = (await sessionPersistence.list()).map(record => record?.header ?? record).filter(header => header?.id === sessionId)
  if (persisted.length > 1) fail('session-conflict', 'Session metadata is ambiguous.')

  const stored = persisted[0]
  if (live && stored && !sameHeaderIdentity(live, stored)) {
    fail('session-conflict', 'Live and persisted session metadata do not match.')
  }
  const header = live ?? stored
  if (!header) fail('session-not-found', 'The requested session is not available.')
  if (typeof header.cwd !== 'string' || !platformAbsolute(header.cwd)) {
    fail('session-root-unavailable', 'The session has no usable creation directory.')
  }

  let root
  try {
    root = await realpath(header.cwd)
    const info = await stat(root)
    if (!info.isDirectory()) fail('session-root-unavailable', 'The session creation directory is not a directory.')
  } catch (error) {
    if (error?.code?.startsWith?.('session-')) throw error
    fail('session-root-unavailable', 'The session creation directory is unavailable.')
  }
  return Object.freeze({ header, root })
}

export { sameHeaderIdentity }
