const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { normalizeEndpoint } = require('./endpoint.cjs')

class EndpointStore {
  constructor(filename) {
    this.filename = filename
  }

  load() {
    let raw
    try {
      raw = fs.readFileSync(this.filename, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return []
      throw error
    }
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) throw new Error('endpoint store must contain an array')
    const endpoints = parsed.map((entry) => normalizeEndpoint(entry))
    assertUnique(endpoints)
    return endpoints
  }

  save(entries) {
    if (!Array.isArray(entries)) throw new TypeError('entries must be an array')
    const endpoints = entries.map((entry) => normalizeEndpoint(entry))
    assertUnique(endpoints)
    fs.mkdirSync(path.dirname(this.filename), { recursive: true, mode: 0o700 })
    const temporary = `${this.filename}.${randomUUID()}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(endpoints, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.filename)
    fs.chmodSync(this.filename, 0o600)
    return endpoints
  }
}

function assertUnique(endpoints) {
  const ids = new Set()
  const ports = new Set()
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) throw new Error(`duplicate endpoint id: ${endpoint.id}`)
    if (ports.has(endpoint.localPort)) throw new Error(`local port ${endpoint.localPort} is already assigned`)
    ids.add(endpoint.id)
    ports.add(endpoint.localPort)
  }
}

module.exports = { EndpointStore, assertUnique }
