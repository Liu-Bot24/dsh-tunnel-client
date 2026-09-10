import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { resolveSessionRoot, sameHeaderIdentity } from '../src/session-root.mjs'

async function withRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-root-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('resolves a matching live and persisted session creation directory', async () => {
  await withRoot(async root => {
    const header = { id: 'one', createdAt: 1, version: 0, cwd: root }
    const result = await resolveSessionRoot({
      sessions: { get: () => ({ header }) },
      sessionPersistence: { list: async () => [{ ...header }] },
    }, 'one')
    assert.equal(result.root, await realpath(root))
  })
})

test('rejects conflicting live and persisted session identities', async () => {
  await withRoot(async root => {
    await assert.rejects(() => resolveSessionRoot({
      sessions: { get: () => ({ header: { id: 'one', createdAt: 1, version: 0, cwd: root } }) },
      sessionPersistence: { list: async () => [{ id: 'one', createdAt: 2, version: 0, cwd: root }] },
    }, 'one'), error => error.code === 'session-conflict')
  })
})

test('header identity uses immutable id, creation time, and cwd', () => {
  const base = { id: 'one', createdAt: 1, cwd: '/tmp/one', version: 0 }
  assert.equal(sameHeaderIdentity(base, { ...base, version: 99 }), true)
  assert.equal(sameHeaderIdentity(base, { ...base, cwd: '/tmp/two' }), false)
})


test('resolves an inactive session from the new persistence snapshot without losing conflict checks', async () => {
  await withRoot(async root => {
    const header = { id: 'one', createdAt: 1, version: 3, cwd: root }
    const persistence = { list: async () => [{ header, revision: 'opaque-revision' }] }
    const result = await resolveSessionRoot({ sessions: { get: () => undefined }, sessionPersistence: persistence }, 'one')
    assert.equal(result.root, await realpath(root))
    await assert.rejects(() => resolveSessionRoot({ sessions: { get: () => ({ header: { ...header, createdAt: 2 } }) }, sessionPersistence: persistence }, 'one'), error => error.code === 'session-conflict')
  })
})
