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

test('stores and reloads endpoints atomically', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  const saved = store.save([{ id: 'one', name: 'One', sshHost: 'one', localPort: 13080 }])
  assert.deepEqual(store.load(), saved)
  assert.equal(fs.statSync(path.join(directory, 'endpoints.json')).mode & 0o777, 0o600)
})

test('rejects duplicate local ports', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  assert.throws(() => store.save([
    { id: 'one', name: 'One', sshHost: 'one', localPort: 13080 },
    { id: 'two', name: 'Two', sshHost: 'two', localPort: 13080 },
  ]), /已分配给其他主机/)
})

test('allows multiple local endpoints because they do not reserve tunnel ports', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new EndpointStore(path.join(directory, 'endpoints.json'))
  const saved = store.save([
    { id: 'local-one', mode: 'local', name: 'Local One', remotePort: 3080 },
    { id: 'local-two', mode: 'local', name: 'Local Two', remotePort: 3081 },
  ])
  assert.equal(saved.every((endpoint) => endpoint.localPort === null), true)
})

test('uses and persists a supported interface theme', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'settings.json')
  const store = new SettingsStore(filename)

  assert.deepEqual(store.load(), { theme: DEFAULT_THEME })
  const saved = store.save({ theme: SUPPORTED_THEMES[2] })
  assert.deepEqual(store.load(), saved)
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600)
})

test('rejects unknown interface themes', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tunnel-settings-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const store = new SettingsStore(path.join(directory, 'settings.json'))
  assert.throws(() => store.save({ theme: 'made-up-theme' }), /主题不可用/)
})
