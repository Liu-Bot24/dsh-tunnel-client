import { constants as fsConstants } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyProducedPath } = require('./path-policy.cjs')

const IMAGE_MEDIA_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'],
])

export const MAX_TEXT_ARTIFACT_BYTES = 5 * 1024 * 1024
export const MAX_IMAGE_ARTIFACT_BYTES = 20 * 1024 * 1024
export const MAX_ARTIFACT_BYTES = MAX_TEXT_ARTIFACT_BYTES

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

function startsWith(bytes, signature) {
  return bytes.length >= signature.length
    && signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes, start, length) {
  return bytes.subarray(start, start + length).toString('ascii')
}

function validAvif(bytes) {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== 'ftyp') return false
  const boxSize = bytes.readUInt32BE(0)
  if (boxSize < 16) return false
  const end = Math.min(boxSize, bytes.length, 128)
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    const brand = ascii(bytes, offset, 4)
    if (brand === 'avif' || brand === 'avis') return true
  }
  return false
}

function validImageSignature(extension, bytes) {
  switch (extension) {
    case '.png':
      return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case '.jpg':
    case '.jpeg':
      return startsWith(bytes, [0xff, 0xd8, 0xff])
        && bytes.length >= 4
        && bytes.at(-2) === 0xff
        && bytes.at(-1) === 0xd9
    case '.gif':
      return ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a'
    case '.webp':
      return bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP'
    case '.avif':
      return validAvif(bytes)
    default:
      return false
  }
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
    const imageMediaType = IMAGE_MEDIA_TYPES.get(policy.extension)
    const maximumBytes = imageMediaType ? MAX_IMAGE_ARTIFACT_BYTES : MAX_TEXT_ARTIFACT_BYTES
    if (before.size > BigInt(maximumBytes)) fail('file-too-large', 'The produced file is too large to preview.')

    const canonicalRoot = await realpath(root)
    const canonicalFile = await realpath(candidate)
    if (!contained(canonicalRoot, canonicalFile)) fail('outside-session-root', 'The produced file is outside the session directory.')
    const named = await stat(candidate, { bigint: true })
    if (!sameFile(before, named)) fail('file-changed', 'The produced file changed before it was read.')

    const bytes = await readExact(fileHandle, Number(before.size))
    const after = await fileHandle.stat({ bigint: true })
    if (!stableFile(before, after)) fail('file-changed', 'The produced file changed while it was being read.')

    if (imageMediaType) {
      if (!validImageSignature(policy.extension, bytes)) {
        fail('invalid-image', 'The produced image does not match its file type.')
      }
      return Object.freeze({
        content: bytes.toString('base64'),
        encoding: 'base64',
        mediaType: imageMediaType,
        extension: policy.extension,
        name: path.basename(candidate),
        size: bytes.byteLength,
      })
    }

    let content
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      fail('invalid-utf8', 'The produced file is not valid UTF-8 text.')
    }
    return Object.freeze({
      content,
      encoding: 'utf8',
      mediaType: policy.extension === '.svg' ? 'image/svg+xml' : 'text/html',
      extension: policy.extension,
      name: path.basename(candidate),
      size: bytes.byteLength,
    })
  } finally {
    await fileHandle.close().catch(() => {})
  }
}

export { contained, resolveCandidate, validImageSignature }
