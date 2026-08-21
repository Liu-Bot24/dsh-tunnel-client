const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { normalizeEndpoint } = require('./endpoint.cjs')

const SUPPORTED_THEMES = Object.freeze([
  'whale-song',
  'nautical-chart',
  'phosphor',
  'bauhaus-signal',
  'soft-porcelain',
])
const DEFAULT_THEME = 'whale-song'

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
    if (!Array.isArray(parsed)) throw new Error('主机配置文件格式不正确')
    const endpoints = parsed.map((entry) => normalizeEndpoint(entry))
    assertUnique(endpoints)
    return endpoints
  }

  save(entries) {
    if (!Array.isArray(entries)) throw new TypeError('主机列表格式不正确')
    const endpoints = entries.map((entry) => normalizeEndpoint(entry))
    assertUnique(endpoints)
    writeJson(this.filename, endpoints)
    return endpoints
  }
}

class SettingsStore {
  constructor(filename) {
    this.filename = filename
  }

  load() {
    let raw
    try {
      raw = fs.readFileSync(this.filename, 'utf8')
    } catch (error) {
      if (error && error.code === 'ENOENT') return normalizeSettings({})
      throw error
    }
    return normalizeSettings(JSON.parse(raw))
  }

  save(input) {
    const settings = normalizeSettings(input)
    writeJson(this.filename, settings)
    return settings
  }
}

function normalizeSettings(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('设置格式不正确')
  }
  const theme = input.theme ?? DEFAULT_THEME
  if (!SUPPORTED_THEMES.includes(theme)) throw new Error('这个主题不可用')
  return { theme }
}

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, filename)
  fs.chmodSync(filename, 0o600)
}

function assertUnique(endpoints) {
  const ids = new Set()
  const ports = new Set()
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) throw new Error('主机标识重复')
    if (endpoint.mode === 'ssh' && ports.has(endpoint.localPort)) {
      throw new Error(`本地端口 ${endpoint.localPort} 已分配给其他主机`)
    }
    ids.add(endpoint.id)
    if (endpoint.mode === 'ssh') ports.add(endpoint.localPort)
  }
}

module.exports = {
  DEFAULT_THEME,
  EndpointStore,
  SettingsStore,
  SUPPORTED_THEMES,
  assertUnique,
  normalizeSettings,
}
