import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  LocalDshManager,
  findNextAvailablePort,
} = require('../src/core/local-dsh-manager.cjs')
const { WebAuthHandoffStore } = require('../src/core/web-auth.cjs')

const executable = process.argv[2]
if (!executable) throw new Error('usage: node scripts/verify-dsh-web-auth.mjs <dsh-executable>')

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tunnel-auth-acceptance-'))
const dshHome = path.join(root, 'dsh-home')
const operatorHome = path.join(root, 'operator-home')
await Promise.all([
  fs.mkdir(dshHome, { recursive: true }),
  fs.mkdir(operatorHome, { recursive: true }),
])

const port = await findNextAvailablePort(31900)
const manager = new LocalDshManager({
  executable,
  cwd: root,
  environment: { ...process.env, DSH_HOME: dshHome },
  authHandoff: new WebAuthHandoffStore({ homeDirectory: operatorHome }),
  noOpenSupported: true,
  startupTimeout: 120_000,
})

try {
  const state = await manager.start(port)
  assert.equal(state.state, 'running')
  assert.doesNotMatch(JSON.stringify(state), /token/u)

  const cleanUrl = `http://127.0.0.1:${port}/`
  const unauthenticated = await fetch(cleanUrl, { redirect: 'manual' })
  assert.equal(unauthenticated.status, 401)

  const exchange = await fetch(manager.getOpenUrl(port), { redirect: 'manual' })
  assert.equal(exchange.status, 303)
  assert.equal(exchange.headers.get('location'), '/')
  const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
  assert.ok(cookie)

  const authenticated = await fetch(cleanUrl, { headers: { cookie } })
  assert.equal(authenticated.status, 200)
  assert.match(await authenticated.text(), /<title>DeepSeek Harness<\/title>/u)

  const handoff = path.join(operatorHome, '.dsh-tunnel', `web-auth-${port}.json`)
  const handoffMode = (await fs.stat(handoff)).mode & 0o777
  if (process.platform !== 'win32') assert.equal(handoffMode, 0o600)

  await manager.stop()
  await assert.rejects(() => fs.access(handoff), error => error?.code === 'ENOENT')
  console.log(JSON.stringify({
    status: 'passed',
    unauthenticatedStatus: 401,
    exchangeStatus: 303,
    authenticatedStatus: 200,
    handoffRemoved: true,
  }))
} finally {
  if (manager.hasOwnedProcess()) await manager.stop().catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
}
