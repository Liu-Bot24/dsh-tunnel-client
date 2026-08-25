import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createArtifactPreviewRpcHandler } from '../src/host-rpc.mjs'

async function fixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-rpc-'))
  const header = { id: 'session-1', createdAt: 1, version: 0, cwd: root }
  const handler = createArtifactPreviewRpcHandler({
    sessions: { get: id => id === header.id ? { header } : undefined },
    sessionPersistence: { list: async () => [{ ...header }] },
  })
  try { await run({ root, handler }) } finally { await rm(root, { recursive: true, force: true }) }
}

test('returns preview content for an exact read request', async () => {
  await fixture(async ({ root, handler }) => {
    await writeFile(path.join(root, 'demo.html'), '<title>demo</title>')
    const result = await handler('read', { sessionId: 'session-1', producedPath: 'demo.html' }, new AbortController().signal)
    assert.equal(result.ok, true)
    assert.equal(result.value.content, '<title>demo</title>')
  })
})

test('fails closed for native files and malformed payloads', async () => {
  await fixture(async ({ root, handler }) => {
    await writeFile(path.join(root, 'notes.txt'), 'notes')
    const native = await handler('read', { sessionId: 'session-1', producedPath: 'notes.txt' }, new AbortController().signal)
    assert.equal(native.ok, false)
    assert.equal(native.error.code, 'not-previewable')

    const malformed = await handler('read', { sessionId: 'session-1', producedPath: 'demo.html', cwd: root }, new AbortController().signal)
    assert.equal(malformed.ok, false)
    assert.equal(malformed.error.code, 'bad-request')
  })
})
