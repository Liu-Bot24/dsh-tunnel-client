const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EndpointStore } = require('../src/core/store.cjs')

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
  ]), /already assigned/)
})
