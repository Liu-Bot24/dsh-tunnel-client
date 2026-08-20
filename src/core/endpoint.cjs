const { randomUUID } = require('node:crypto')

const HOST_PATTERN = /^[A-Za-z0-9_.:[\]-]+$/
const USER_PATTERN = /^[A-Za-z0-9._-]+$/
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function text(value, field, maxLength) {
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const result = value.trim()
  if (result.length === 0) throw new Error(`${field} is required`)
  if (result.length > maxLength) throw new Error(`${field} is too long`)
  return result
}

function port(value, field, { optional = false, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && optional) return null
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value)
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) {
    throw new Error(`${field} must be an integer between 1 and 65535`)
  }
  return candidate
}

function normalizeEndpoint(input, { idFactory = randomUUID } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('endpoint must be an object')
  }

  const name = text(input.name, 'name', 80)
  const sshHost = text(input.sshHost, 'sshHost', 255)
  if (!HOST_PATTERN.test(sshHost) || sshHost.startsWith('-')) {
    throw new Error('sshHost must be a hostname, IP address, or SSH config alias')
  }

  let sshUser = null
  if (input.sshUser !== undefined && input.sshUser !== null && String(input.sshUser).trim() !== '') {
    sshUser = text(input.sshUser, 'sshUser', 80)
    if (!USER_PATTERN.test(sshUser) || sshUser.startsWith('-')) throw new Error('sshUser is invalid')
  }

  const id = input.id === undefined || input.id === null || input.id === ''
    ? idFactory()
    : text(input.id, 'id', 128)
  if (!ID_PATTERN.test(id)) throw new Error('id is invalid')

  return Object.freeze({
    id,
    name,
    sshHost,
    sshUser,
    sshPort: port(input.sshPort, 'sshPort', { optional: true }),
    remotePort: port(input.remotePort, 'remotePort', { fallback: 3080 }),
    localPort: port(input.localPort, 'localPort', { fallback: 13080 }),
  })
}

function loopbackUrl(endpoint) {
  const normalized = normalizeEndpoint(endpoint)
  return `http://127.0.0.1:${normalized.localPort}/`
}

module.exports = { normalizeEndpoint, loopbackUrl }
