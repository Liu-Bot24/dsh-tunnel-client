import { resolveSessionRoot } from './session-root.mjs'
import { readPreviewArtifact } from './safe-reader.mjs'

function failure(code, message) {
  if (code === 'internal' || code === 'cancelled') {
    return { ok: false, error: { code, message, details: {} } }
  }
  // Connection validates a closed RPC error union; plugin-specific reasons belong in issue details.
  return { ok: false, error: {
    code: 'bad-request', message,
    details: { issues: [{ code: 'custom', path: [], message, params: { artifactPreviewCode: code } }] },
  } }
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validPayload(payload) {
  if (!isPlainRecord(payload)) return false
  const keys = Object.keys(payload)
  return keys.length === 2
    && keys.includes('sessionId')
    && keys.includes('producedPath')
    && typeof payload.sessionId === 'string'
    && payload.sessionId.length > 0
    && payload.sessionId.length <= 512
    && typeof payload.producedPath === 'string'
    && payload.producedPath.length > 0
    && payload.producedPath.length <= 4096
}

const SAFE_ERRORS = new Set([
  'session-conflict',
  'session-not-found',
  'session-root-unavailable',
  'invalid-path',
  'not-previewable',
  'outside-session-root',
  'file-unavailable',
  'linked-path',
  'linked-file',
  'not-regular-file',
  'file-too-large',
  'file-changed',
  'invalid-utf8',
  'invalid-image',
])

export function createArtifactPreviewRpcHandler({ sessions, sessionPersistence }) {
  return async (endpoint, payload, signal) => {
    if (endpoint !== 'read') return failure('not-found', 'Unknown artifact preview endpoint.')
    if (signal?.aborted) return failure('cancelled', 'Artifact preview was cancelled.')
    if (!validPayload(payload)) return failure('bad-request', 'Invalid artifact preview request.')

    try {
      const { root } = await resolveSessionRoot({ sessions, sessionPersistence }, payload.sessionId)
      if (signal?.aborted) return failure('cancelled', 'Artifact preview was cancelled.')
      const artifact = await readPreviewArtifact(root, payload.producedPath)
      return { ok: true, value: artifact }
    } catch (error) {
      if (SAFE_ERRORS.has(error?.code)) return failure(error.code, error.message)
      return failure('internal', 'Artifact preview could not complete this request.')
    }
  }
}
