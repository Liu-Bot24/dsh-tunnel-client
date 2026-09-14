const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { resolveAccessLink, LINK_UNAVAILABLE } = require('../src/core/access-link.cjs')
const { WebAuthHandoffStore, DSH_AUTH_REQUIRED_BODY, rewriteAuthenticatedWebUrl } = require('../src/core/web-auth.cjs')
const { LocalDshManager } = require('../src/core/local-dsh-manager.cjs')
const { TunnelManager } = require('../src/core/tunnel-manager.cjs')
const TOKEN = 'current-test-launch-token-123456789'
const STALE = 'expired-test-launch-token-123456789'

async function service(t, { legacy = false, unrelated = false, fakeExchange = false } = {}) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const url = new URL(req.url, 'http://localhost')
    if (unrelated) { res.end('Other service'); return }
    if (url.searchParams.get('token') === TOKEN) {
      res.writeHead(303, { location: '/', 'set-cookie': 'session=valid; HttpOnly' }); res.end(); return
    }
    if (legacy || (!fakeExchange && req.headers.cookie === 'session=valid')) { res.end('<title>DeepSeek Harness</title>'); return }
    res.writeHead(401); res.end(DSH_AUTH_REQUIRED_BODY)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const port = server.address().port
  return { port, requests, url: token => `http://127.0.0.1:${port}/?token=${token}` }
}

test('valid live token is reusable and does not require a fresh secret read', async t => {
  const s = await service(t)
  for (let i = 0; i < 2; i++) assert.equal(await resolveAccessLink({ port: s.port, cachedUrl: s.url(TOKEN), readFreshUrl() { assert.fail('unneeded read') } }), s.url(TOKEN))
})

test('expired token is replaced with the current handoff and wrong tokens never return a bare link', async t => {
  const s = await service(t)
  assert.equal(await resolveAccessLink({ port: s.port, cachedUrl: s.url(STALE), readFreshUrl: async () => s.url(TOKEN) }), s.url(TOKEN))
  await assert.rejects(resolveAccessLink({ port: s.port, cachedUrl: s.url(STALE), readFreshUrl: async () => s.url(STALE) }), { message: LINK_UNAVAILABLE })
})

test('external authenticated service adopts a verified handoff without starting or stopping a process', async t => {
  const s = await service(t)
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-link-test-'))
  t.after(() => fs.rm(home, { force: true, recursive: true }))
  const store = new WebAuthHandoffStore({ homeDirectory: home })
  await store.publish(s.port, s.url(TOKEN), 999999)
  // The HTTP exchange, not a possibly recycled PID, proves the record belongs to this service.
  const manager = new LocalDshManager({ authHandoff: store, probe: async () => 'dsh-auth', spawnProcess() { assert.fail('must not restart') } })
  assert.equal((await manager.inspect(s.port)).owned, false)
  assert.equal(await manager.resolveOpenUrl(s.port), s.url(TOKEN))
  await store.clear(s.port)
  await assert.rejects(manager.resolveOpenUrl(s.port), { message: LINK_UNAVAILABLE })
})

test('legacy DSH works without tokens but unrelated listeners and fake cookie exchanges are rejected', async t => {
  const old = await service(t, { legacy: true })
  assert.equal(await resolveAccessLink({ port: old.port }), `http://127.0.0.1:${old.port}/`)
  const other = await service(t, { unrelated: true })
  await assert.rejects(resolveAccessLink({ port: other.port }), /不是可用的 DSH/)
  const fake = await service(t, { fakeExchange: true })
  await assert.rejects(resolveAccessLink({ port: fake.port, cachedUrl: fake.url(TOKEN) }), { message: LINK_UNAVAILABLE })
})

test('forwarded links use the controlling port and re-read remote auth after rotation', async t => {
  const s = await service(t)
  const endpoint = { id: 'remote', mode: 'ssh', name: 'Test host', sshHost: 'example.test', sshUser: '', sshPort: null, remotePort: 3080, localPort: s.port }
  const manager = new TunnelManager({ resolveRemoteAuth: async () => `http://127.0.0.1:3080/?token=${TOKEN}` })
  manager.records.set('remote', { endpoint, state: 'connected', authUrl: rewriteAuthenticatedWebUrl(`http://127.0.0.1:3080/?token=${STALE}`, endpoint), exited: false })
  const result = new URL(await manager.resolveOpenUrl('remote'))
  assert.equal(result.port, String(s.port)); assert.equal(result.searchParams.get('token'), TOKEN)
  assert.equal(result.hash, '#dsh_tunnel_preview=web')
  assert.doesNotMatch(JSON.stringify(manager.get('remote')), /token|authUrl/)
})

test('disconnect while resolving a fresh link cannot yield a successful copy target', async t => {
  const s = await service(t)
  const record = { endpoint: { remotePort: 3080, localPort: s.port }, state: 'connected', authUrl: null, exited: false }
  const manager = new TunnelManager({ resolveRemoteAuth: async () => { record.state = 'stopped'; return `http://127.0.0.1:3080/?token=${TOKEN}` } })
  manager.records.set('remote', record)
  await assert.rejects(manager.resolveOpenUrl('remote'), /SSH 连接已中断/)
})

test('untrusted link origins and wrong ports are not contacted and errors contain no credentials', async t => {
  const s = await service(t)
  await assert.rejects(resolveAccessLink({ port: s.port, cachedUrl: `http://example.invalid/?token=${TOKEN}`, readFreshUrl: async () => `http://127.0.0.1:1/?token=${TOKEN}` }), error => error.message === LINK_UNAVAILABLE && !error.message.includes(TOKEN))
  assert.deepEqual(s.requests, ['/'])
})
