const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const { probeLocalService } = require('../src/core/local-dsh-manager.cjs')
const {
  DSH_AUTH_REQUIRED_BODY,
  WebAuthHandoffStore,
  parseDshWebUrlLine,
  rewriteAuthenticatedWebUrl,
} = require('../src/core/web-auth.cjs')

const TOKEN = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-token'

async function listen(handler) {
  const server = http.createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

test('accepts only the tokenized loopback URL printed for the expected DSH port', () => {
  const line = `dsh web: http://127.0.0.1:3080/?token=${TOKEN} (LAN: http://example.invalid/)`
  assert.equal(
    parseDshWebUrlLine(line, 3080),
    `http://127.0.0.1:3080/?token=${TOKEN}`,
  )
  assert.equal(parseDshWebUrlLine('dsh web: http://127.0.0.1:3080/', 3080), null)
  assert.equal(parseDshWebUrlLine(`dsh web: http://example.com:3080/?token=${TOKEN}`, 3080), null)
  assert.equal(parseDshWebUrlLine(`dsh web: http://127.0.0.1:3081/?token=${TOKEN}`, 3080), null)
  assert.equal(parseDshWebUrlLine(`dsh web: http://127.0.0.1:3080/?token=${TOKEN}&token=again`, 3080), null)
})

test('rewrites only the authority for SSH forwarding and preserves authentication plus preview markers', () => {
  const result = rewriteAuthenticatedWebUrl(`http://127.0.0.1:3080/?token=${TOKEN}`, {
    remotePort: 3080,
    localPort: 13080,
  })
  const url = new URL(result)
  assert.equal(url.origin, 'http://127.0.0.1:13080')
  assert.equal(url.searchParams.get('token'), TOKEN)
  assert.equal(url.searchParams.has('dsh_tunnel_preview'), false)
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('dsh_tunnel_preview'), 'web')
})

test('writes a private process-lifetime handoff and removes only its own record', async t => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dsh-tunnel-web-auth-'))
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }))
  const first = new WebAuthHandoffStore({ homeDirectory: home, ownerId: 'first' })
  const second = new WebAuthHandoffStore({ homeDirectory: home, ownerId: 'second' })
  const url = `http://127.0.0.1:3080/?token=${TOKEN}`
  await first.publish(3080, url, 42)
  const filename = path.join(home, '.dsh-tunnel', 'web-auth-3080.json')
  const parsed = JSON.parse(await fs.promises.readFile(filename, 'utf8'))
  assert.equal(parsed.url, url)
  assert.equal(parsed.ownerId, 'first')
  if (process.platform !== 'win32') {
    assert.equal((await fs.promises.stat(filename)).mode & 0o777, 0o600)
    assert.equal((await fs.promises.stat(path.dirname(filename))).mode & 0o777, 0o700)
  }
  await second.remove(3080)
  await fs.promises.access(filename)
  await first.remove(3080)
  await assert.rejects(() => fs.promises.access(filename), error => error?.code === 'ENOENT')
})

test('distinguishes an authenticated DSH 401 from an unrelated listener', async t => {
  const auth = await listen((_request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end(DSH_AUTH_REQUIRED_BODY)
  })
  const unrelated = await listen((_request, response) => {
    response.writeHead(401, { 'content-type': 'text/plain' })
    response.end('unauthorized')
  })
  t.after(() => Promise.all([
    new Promise(resolve => auth.close(resolve)),
    new Promise(resolve => unrelated.close(resolve)),
  ]))
  assert.equal(await probeLocalService(auth.address().port), 'dsh-auth')
  assert.equal(await probeLocalService(unrelated.address().port), 'occupied')
})
