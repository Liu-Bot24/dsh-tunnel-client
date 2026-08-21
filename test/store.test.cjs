const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  DEFAULT_THEME,
  EndpointStore,
  SettingsStore,
  SUPPORTED_THEMES,
} = require('../src/core/store.cjs')

function assertPrivatePosixMode(filename) {
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
  }
}

test('stores and reloads endpoints atomically', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  const saved = store.save([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
    { id: 'one', name: 'One', sshHost: 'one', localPort: 13080 },
  ])
  assert.deepEqual(store.load(), saved)
  assertPrivatePosixMode(path.join(directory, 'endpoints.json'))
  assert.deepEqual(fs.readdirSync(directory), ['endpoints.json'])
})

test('rejects duplicate local ports', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  assert.throws(() => store.save([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
    { id: 'one', name: 'One', sshHost: 'one', localPort: 13080 },
    { id: 'two', name: 'Two', sshHost: 'two', localPort: 13080 },
  ]), /已分配给其他主机/)
})

test('rejects multiple local endpoints', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  assert.throws(() => store.save([
    { id: 'local-dsh', mode: 'local', name: 'Local One', remotePort: 3080 },
    { id: 'local-dsh', mode: 'local', name: 'Local Two', remotePort: 3081 },
  ]), /重复/)
})

test('adds the fixed local endpoint to an older valid configuration once', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'endpoints.json')
  fs.writeFileSync(filename, JSON.stringify([
    { id: 'one', name: 'One', mode: 'ssh', sshHost: 'one', remotePort: 3080, localPort: 13080 },
  ]))
  const store = new EndpointStore(filename)
  const first = store.loadOrInitialize([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
  ])
  assert.equal(first.status, 'migrated')
  assert.equal(first.entries[0].id, 'local-dsh')
  const bytes = fs.readFileSync(filename)
  const second = store.loadOrInitialize([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
  ])
  assert.equal(second.status, 'loaded')
  assert.deepEqual(fs.readFileSync(filename), bytes)
})

test('backs up corrupt endpoint bytes before restoring defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'endpoints.json')
  const corrupt = Buffer.from('{"private":"unterminated"', 'utf8')
  fs.writeFileSync(filename, corrupt)
  const store = new EndpointStore(filename)
  const result = store.loadOrInitialize([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
  ], { now: () => new Date('2026-08-21T00:00:00.000Z') })
  assert.equal(result.status, 'recovered')
  assert.deepEqual(fs.readFileSync(result.backupFilename), corrupt)
  assert.equal(store.load()[0].id, 'local-dsh')
})

test('keeps a corrupt configuration untouched when backup fails', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'endpoints.json')
  const corrupt = Buffer.from('[{"id":"partial"}]', 'utf8')
  fs.writeFileSync(filename, corrupt)
  const fileSystem = {
    ...fs,
    copyFileSync: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) },
  }
  const store = new EndpointStore(filename, { fileSystem })
  const result = store.loadOrInitialize([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
  ])
  assert.equal(result.status, 'read-only')
  assert.deepEqual(fs.readFileSync(filename), corrupt)
  assert.equal(result.entries[0].id, 'local-dsh')
})

test('uses read-only defaults when the endpoint file cannot be read', () => {
  const denied = Object.assign(new Error('denied'), { code: 'EACCES' })
  const fileSystem = {
    ...fs,
    readFileSync: () => { throw denied },
    copyFileSync: () => { throw denied },
  }
  const store = new EndpointStore('/unreadable/endpoints.json', { fileSystem })
  const result = store.loadOrInitialize([
    { id: 'local-dsh', mode: 'local', name: 'Local', remotePort: 3080 },
  ])
  assert.equal(result.status, 'read-only')
  assert.equal(result.entries[0].id, 'local-dsh')
})

test('uses and persists a supported interface theme', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const store = new SettingsStore(filename)

  assert.deepEqual(store.load(), { theme: DEFAULT_THEME })
  const saved = store.save({ theme: SUPPORTED_THEMES[2] })
  assert.deepEqual(store.load(), saved)
  assertPrivatePosixMode(filename)
  assert.deepEqual(fs.readdirSync(directory), ['settings.json'])
})

test('rejects unknown interface themes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new SettingsStore(path.join(directory, 'settings.json'))
  assert.throws(() => store.save({ theme: 'made-up-theme' }), /主题不可用/)
})
