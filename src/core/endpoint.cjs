const { randomUUID } = require('node:crypto')

const HOST_PATTERN = /^[A-Za-z0-9_.:[\]-]+$/
const USER_PATTERN = /^[A-Za-z0-9._-]+$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ENDPOINT_MODES = Object.freeze(['local', 'ssh'])
const FIELD_LABELS = Object.freeze({
  name: '显示名称',
  sshHost: 'SSH 地址',
  sshUser: 'SSH 用户',
  sshPort: 'SSH 端口',
  remotePort: 'DSH 端口',
  localPort: '本地端口',
  id: '主机标识',
})

function fieldLabel(field) {
  return FIELD_LABELS[field] ?? '字段'
}

function text(value, field, maxLength) {
  const label = fieldLabel(field)
  if (typeof value !== 'string') throw new TypeError(`${label}格式不正确`)
  const result = value.trim()
  if (result.length === 0) throw new Error(`请填写${label}`)
  if (result.length > maxLength) throw new Error(`${label}太长`)
  return result
}

function port(value, field, { optional = false, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new Error(`${fieldLabel(field)}必须是 1–65535 之间的整数`)
  }
  return candidate
}

function normalizeEndpoint(input, { idFactory = randomUUID } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('主机配置格式不正确')
  }

  const mode = input.mode ?? 'ssh'
  if (!ENDPOINT_MODES.includes(mode)) throw new Error('连接方式不可用')

  const name = text(input.name, 'name', 80)
  let sshHost = null
  let sshUser = null
  let sshPort = null

  if (mode === 'ssh') {
    sshHost = text(input.sshHost, 'sshHost', 255)
    if (!HOST_PATTERN.test(sshHost) || sshHost.startsWith('-')) {
      throw new Error('SSH 地址格式不正确')
    }
    if (input.sshUser !== undefined && input.sshUser !== null && String(input.sshUser).trim() !== '') {
      sshUser = text(input.sshUser, 'sshUser', 80)
      if (!USER_PATTERN.test(sshUser) || sshUser.startsWith('-')) throw new Error('SSH 用户格式不正确')
    }
    sshPort = port(input.sshPort, 'sshPort', { optional: true })
  }

  const id = input.id === undefined || input.id === null || input.id === ''
    ? idFactory()
    : text(input.id, 'id', 128)
  if (!ID_PATTERN.test(id)) throw new Error('主机标识格式不正确')

  return Object.freeze({
    id,
    name,
    mode,
    sshHost,
    sshUser,
    sshPort,
    remotePort: port(input.remotePort, 'remotePort', { fallback: 3080 }),
    localPort: mode === 'ssh' ? port(input.localPort, 'localPort', { fallback: 13080 }) : null,
  })
}

function loopbackUrl(endpoint) {
  const normalized = normalizeEndpoint(endpoint)
  const portNumber = normalized.mode === 'local' ? normalized.remotePort : normalized.localPort
  return `http://127.0.0.1:${portNumber}/`
}

module.exports = { ENDPOINT_MODES, normalizeEndpoint, loopbackUrl }
