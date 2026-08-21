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
  constructor(filename, { fileSystem = fs } = {}) {
    this.filename = filename
    this.fs = fileSystem
  }

  load() {
    let raw
    try {
      raw = this.fs.readFileSync(this.filename, 'utf8')
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
    assertUnique(endpoints, { requireLocal: true })
    writeJson(this.filename, endpoints, this.fs)
    return endpoints
  }

  loadOrInitialize(defaultEntries, { now = () => new Date() } = {}) {
    const defaults = defaultEntries.map((entry) => normalizeEndpoint(entry))
    assertUnique(defaults, { requireLocal: true })
    let entries
    try {
      entries = this.load()
    } catch (error) {
      return this.#recover(defaults, error, now)
    }

    if (!this.fs.existsSync(this.filename)) {
      try {
        return { entries: this.save(defaults), status: 'created', backupFilename: null, error: null }
      } catch (error) {
        return { entries: defaults, status: 'read-only', backupFilename: null, error }
      }
    }

    if (!entries.some((entry) => entry.mode === 'local')) {
      try {
        return {
          entries: this.save([...defaults.filter((entry) => entry.mode === 'local'), ...entries]),
          status: 'migrated',
          backupFilename: null,
          error: null,
        }
      } catch (error) {
        return {
          entries: [...defaults.filter((entry) => entry.mode === 'local'), ...entries],
          status: 'read-only',
          backupFilename: null,
          error,
        }
      }
    }
    return { entries, status: 'loaded', backupFilename: null, error: null }
  }

  #recover(defaults, loadError, now) {
    const timestamp = now().toISOString().replace(/[:.]/g, '-')
    const backupFilename = `${this.filename}.${timestamp}.corrupt`
    try {
      this.fs.copyFileSync(this.filename, backupFilename, fs.constants.COPYFILE_EXCL)
    } catch (backupError) {
      return { entries: defaults, status: 'read-only', backupFilename: null, error: backupError, loadError }
    }
    try {
      return {
        entries: this.save(defaults),
        status: 'recovered',
        backupFilename,
        error: loadError,
      }
    } catch (saveError) {
      return {
        entries: defaults,
        status: 'read-only',
        backupFilename,
        error: saveError,
        loadError,
      }
    }
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

function writeJson(filename, value, fileSystem = fs) {
  fileSystem.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
  const temporary = `${filename}.${randomUUID()}.tmp`
  fileSystem.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fileSystem.renameSync(temporary, filename)
  fileSystem.chmodSync(filename, 0o600)
}

function assertUnique(endpoints, { requireLocal = false } = {}) {
  const ids = new Set()
  const ports = new Set()
  let localCount = 0
  for (const endpoint of endpoints) {
    if (ids.has(endpoint.id)) throw new Error('主机标识重复')
    if (endpoint.mode === 'ssh' && ports.has(endpoint.localPort)) {
      throw new Error(`本地端口 ${endpoint.localPort} 已分配给其他主机`)
    }
    ids.add(endpoint.id)
    if (endpoint.mode === 'ssh') ports.add(endpoint.localPort)
    else localCount += 1
  }
  if (localCount > 1) throw new Error('本机 DSH 配置重复')
  if (requireLocal && localCount !== 1) throw new Error('缺少本机 DSH 配置')
}

module.exports = {
  DEFAULT_THEME,
  EndpointStore,
  SettingsStore,
  SUPPORTED_THEMES,
  assertUnique,
  normalizeSettings,
}
