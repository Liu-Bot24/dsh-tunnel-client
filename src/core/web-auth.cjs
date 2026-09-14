const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const DSH_AUTH_REQUIRED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.'
const HANDOFF_DIRECTORY = '.dsh-tunnel'
const HANDOFF_VERSION = 1
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,256}$/u

function isLoopbackHostname(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function authenticatedWebUrl(value, expectedPort) {
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const port = Number(url.port || (url.protocol === 'http:' ? 80 : 0))
  const tokens = url.searchParams.getAll('token')
  if (
    url.protocol !== 'http:'
    || url.username !== ''
    || url.password !== ''
    || !isLoopbackHostname(url.hostname)
    || url.pathname !== '/'
    || url.hash !== ''
    || port !== expectedPort
    || tokens.length !== 1
    || !TOKEN_PATTERN.test(tokens[0])
  ) return null
  return url.toString()
}

function parseDshWebUrlLine(line, expectedPort) {
  const match = String(line).trim().match(/^dsh web:\s+(http:\/\/\S+)/u)
  return match ? authenticatedWebUrl(match[1], expectedPort) : null
}

function handoffFilename(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DSH 端口不可用')
  return `web-auth-${port}.json`
}

function remoteHandoffPath(homeDirectory, port) {
  return `${String(homeDirectory).replace(/[\\/]+$/u, '')}/${HANDOFF_DIRECTORY}/${handoffFilename(port)}`
}

function rewriteAuthenticatedWebUrl(value, endpoint) {
  const parsed = authenticatedWebUrl(value, endpoint.remotePort)
  if (parsed === null) return null
  const url = new URL(parsed)
  url.hostname = '127.0.0.1'
  url.port = String(endpoint.localPort)
  url.hash = new URLSearchParams({ dsh_tunnel_preview: 'web' }).toString()
  return url.toString()
}

class WebAuthHandoffStore {
  constructor({
    homeDirectory,
    fsImpl = fs,
    pathImpl = path,
    ownerId = crypto.randomUUID(),
  }) {
    this.homeDirectory = homeDirectory
    this.fs = fsImpl
    this.path = pathImpl
    this.ownerId = ownerId
  }

  #directory() {
    return this.path.join(this.homeDirectory, HANDOFF_DIRECTORY)
  }

  #filename(port) {
    return this.path.join(this.#directory(), handoffFilename(port))
  }

  async read(port) {
    const filename = this.#filename(port)
    try {
      const directory = await this.fs.promises.lstat(this.#directory())
      const stat = await this.fs.promises.lstat(filename)
      if (!directory.isDirectory() || directory.isSymbolicLink() || !stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) return null
      const record = JSON.parse(await this.fs.promises.readFile(filename, 'utf8'))
      return record.version === HANDOFF_VERSION && record.port === port
        ? authenticatedWebUrl(record.url, port) : null
    } catch { return null }
  }

  async clear(port) {
    try {
      await this.fs.promises.rm(this.#filename(port), { force: true })
    } catch {
      throw new Error('无法清理旧的 DSH 认证信息')
    }
  }

  async publish(port, url, pid = null) {
    const validated = authenticatedWebUrl(url, port)
    if (validated === null) throw new Error('DSH 认证地址不可用')
    const directory = this.#directory()
    const filename = this.#filename(port)
    const temporary = `${filename}.${this.ownerId}.tmp`
    const body = `${JSON.stringify({
      version: HANDOFF_VERSION,
      ownerId: this.ownerId,
      port,
      pid: Number.isInteger(pid) ? pid : null,
      url: validated,
    })}\n`
    try {
      await this.fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
      const directoryStat = await this.fs.promises.lstat(directory)
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new Error('unsafe handoff directory')
      }
      await this.fs.promises.chmod(directory, 0o700).catch(() => undefined)
      await this.fs.promises.writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      await this.fs.promises.chmod(temporary, 0o600).catch(() => undefined)
      try {
        await this.fs.promises.rename(temporary, filename)
      } catch (error) {
        if (!['EEXIST', 'EPERM'].includes(error?.code)) throw error
        await this.fs.promises.rm(filename, { force: true })
        await this.fs.promises.rename(temporary, filename)
      }
      await this.fs.promises.chmod(filename, 0o600).catch(() => undefined)
    } catch {
      await this.fs.promises.rm(temporary, { force: true }).catch(() => undefined)
      throw new Error('DSH 认证信息交接失败')
    }
  }

  async remove(port) {
    const filename = this.#filename(port)
    let parsed
    try {
      parsed = JSON.parse(await this.fs.promises.readFile(filename, 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) return
      throw new Error('无法清理 DSH 认证信息')
    }
    if (parsed?.ownerId !== this.ownerId) return
    await this.fs.promises.rm(filename, { force: true })
  }
}

module.exports = {
  DSH_AUTH_REQUIRED_BODY,
  HANDOFF_DIRECTORY,
  HANDOFF_VERSION,
  WebAuthHandoffStore,
  authenticatedWebUrl,
  handoffFilename,
  parseDshWebUrlLine,
  remoteHandoffPath,
  rewriteAuthenticatedWebUrl,
}
