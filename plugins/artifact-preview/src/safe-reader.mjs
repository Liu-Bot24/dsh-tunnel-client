import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyProducedPath } = require('./path-policy.cjs')

export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  throw error
}

function contained(root, candidate) {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function resolveCandidate(root, producedPath) {
  const driveAbsolute = /^[A-Za-z]:[\\/]/u.test(producedPath)
  if (driveAbsolute && process.platform !== 'win32') fail('invalid-path', 'The produced path belongs to another platform.')
  const candidate = path.resolve(root, producedPath)
  if (!contained(root, candidate) || candidate === root) fail('outside-session-root', 'The produced file is outside the session directory.')
  return candidate
}

async function rejectLinks(root, candidate) {
  const relative = path.relative(root, candidate)
  let cursor = root
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    let info
    try {
      info = await lstat(cursor)
    } catch {
      fail('file-unavailable', 'The produced file is unavailable.')
    }
    if (info.isSymbolicLink()) fail('linked-path', 'Linked paths cannot be previewed.')
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino
}

function stableFile(left, right) {
  return sameFile(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

async function readExact(fileHandle, size) {
  const bytes = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    const result = await fileHandle.read(bytes, offset, size - offset, offset)
    if (result.bytesRead === 0) fail('file-changed', 'The produced file changed while it was being read.')
    offset += result.bytesRead
  }
  return bytes
}

export async function readPreviewArtifact(root, producedPath) {
  const policy = classifyProducedPath(producedPath)
  if (policy.disposition !== 'preview') fail('not-previewable', 'This file type is not previewable.')

  const candidate = resolveCandidate(root, producedPath)
  await rejectLinks(root, candidate)

  const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0))
  let fileHandle
  try {
    fileHandle = await open(candidate, flags)
  } catch {
    fail('file-unavailable', 'The produced file is unavailable.')
  }

  try {
    const before = await fileHandle.stat({ bigint: true })
    if (!before.isFile()) fail('not-regular-file', 'Only regular files can be previewed.')
    if (before.nlink !== 1n) fail('linked-file', 'Files with multiple links cannot be previewed.')
    if (before.size > BigInt(MAX_ARTIFACT_BYTES)) fail('file-too-large', 'The produced file is larger than 5 MiB.')

    const canonicalRoot = await realpath(root)
    const canonicalFile = await realpath(candidate)
    if (!contained(canonicalRoot, canonicalFile)) fail('outside-session-root', 'The produced file is outside the session directory.')
    const named = await stat(candidate, { bigint: true })
    if (!sameFile(before, named)) fail('file-changed', 'The produced file changed before it was read.')

    const bytes = await readExact(fileHandle, Number(before.size))
    const after = await fileHandle.stat({ bigint: true })
    if (!stableFile(before, after)) fail('file-changed', 'The produced file changed while it was being read.')

    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      fail('invalid-utf8', 'The produced file is not valid UTF-8 text.')
    }
    return Object.freeze({
      content,
      extension: policy.extension,
      name: path.basename(candidate),
      size: bytes.byteLength,
    })
  } finally {
    await fileHandle.close().catch(() => {})
  }
}

export { contained, resolveCandidate }
