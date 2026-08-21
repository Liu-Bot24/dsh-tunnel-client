const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { Client } = require('ssh2')
const { normalizeEndpoint } = require('./endpoint.cjs')

const MAX_PASSWORD_LENGTH = 1_024
const MAX_AUTHORIZED_KEYS_SIZE = 1024 * 1024

function normalizedSshHost(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function sshPort(endpoint) {
  return endpoint.sshPort ?? 22
}

function hostToken(host, port = 22) {
  return port === 22 ? host : `[${host}]:${port}`
}

function readSshString(buffer, offset = 0) {
  if (!Buffer.isBuffer(buffer) || buffer.length < offset + 4) throw new Error('SSH 主机密钥格式不正确')
  const length = buffer.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (length <= 0 || end > buffer.length) throw new Error('SSH 主机密钥格式不正确')
  return { value: buffer.subarray(start, end), end }
}

function hostKeyType(rawKey) {
  return readSshString(rawKey).value.toString('ascii')
}

function hostKeyFingerprint(rawKey) {
  return `SHA256:${crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')}`
}

function knownHostsLine(host, port, rawKey) {
  return `${hostToken(host, port)} ${hostKeyType(rawKey)} ${rawKey.toString('base64')}`
}

function matchesHashedHost(candidate, token) {
  const parts = candidate.split('|')
  if (parts.length !== 4 || parts[1] !== '1') return false
  try {
    const salt = Buffer.from(parts[2], 'base64')
    const expected = Buffer.from(parts[3], 'base64')
    const actual = crypto.createHmac('sha1', salt).update(token).digest()
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

function hostFieldMatches(field, token) {
  return field.split(',').some((candidate) => candidate === token || matchesHashedHost(candidate, token))
}

function knownHostsContains(contents, host, port, rawKey) {
  const token = hostToken(host, port)
  const keyType = hostKeyType(rawKey)
  const encodedKey = rawKey.toString('base64')
  return String(contents).split(/\r?\n/).some((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) return false
    const [hosts, type, key] = trimmed.split(/\s+/, 3)
    return type === keyType && key === encodedKey && hostFieldMatches(hosts, token)
  })
}

function commandError(error) {
  if (error?.code === 'ENOENT') return new Error('系统缺少 OpenSSH 工具')
  return error
}

function runCommand(command, args, {
  spawnImpl = spawn,
  timeoutMs = 10_000,
  timeoutMessage = 'SSH 命令执行超时',
  failureMessage = 'SSH 命令执行失败',
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(timeoutMessage))
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout = `${stdout}${String(chunk)}`.slice(-64_000) })
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_096) })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(commandError(error))
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(failureMessage))
    })
  })
}

function parseSshConfigOutput(output) {
  const values = new Map()
  for (const line of String(output).split(/\r?\n/)) {
    const separator = line.indexOf(' ')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    if (!values.has(key)) values.set(key, line.slice(separator + 1).trim())
  }
  const hostname = values.get('hostname')
  const user = values.get('user')
  const port = Number(values.get('port'))
  if (!hostname || !user || !Number.isInteger(port)) throw new Error('无法解析 SSH 主机配置')
  return { hostname, user, port }
}

async function resolveSshEndpoint(endpoint, { run = runCommand } = {}) {
  const normalized = normalizeEndpoint(endpoint)
  const target = normalized.sshUser
    ? `${normalized.sshUser}@${normalized.sshHost}`
    : normalized.sshHost
  const args = ['-G']
  if (normalized.sshPort !== null) args.push('-p', String(normalized.sshPort))
  args.push(target)
  const { stdout } = await run('ssh', args, {
    timeoutMessage: '读取 SSH 主机配置超时',
    failureMessage: '无法读取 SSH 主机配置',
  })
  const resolved = parseSshConfigOutput(stdout)
  return normalizeEndpoint({
    ...normalized,
    sshHost: resolved.hostname,
    sshUser: resolved.user,
    sshPort: resolved.port,
  })
}

function scanHostKey(endpoint, { ClientCtor = Client, timeoutMs = 10_000 } = {}) {
  const normalized = normalizeEndpoint(endpoint)
  const host = normalizedSshHost(normalized.sshHost)
  const port = sshPort(normalized)
  return new Promise((resolve, reject) => {
    const client = new ClientCtor()
    let captured = null
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch {}
      if (captured) resolve({ host, port, rawKey: captured })
      else reject(error ?? new Error('无法读取 SSH 主机密钥'))
    }
    const timer = setTimeout(() => finish(new Error('SSH 主机不可达')), timeoutMs)
    client.once('error', (error) => {
      if (captured) finish()
      else if (error?.code === 'ECONNREFUSED') finish(new Error('SSH 连接被拒绝'))
      else if (error?.code === 'ETIMEDOUT' || error?.code === 'EHOSTUNREACH') finish(new Error('SSH 主机不可达'))
      else finish(new Error('无法读取 SSH 主机密钥'))
    })
    client.once('close', () => finish())
    try {
      client.connect({
        host,
        port,
        username: normalized.sshUser ?? 'dsh-tunnel',
        readyTimeout: timeoutMs,
        hostVerifier: (key) => {
          captured = Buffer.from(key)
          return false
        },
      })
    } catch (error) {
      finish(error)
    }
  })
}

function sftpCall(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (error, value) => {
      if (error) reject(error)
      else resolve(value)
    })
  })
}

function isMissingRemoteFile(error) {
  return error?.code === 2 || error?.code === 'ENOENT' || /no such file/i.test(error?.message ?? '')
}

function readRemoteFile(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    let result = ''
    const stream = sftp.createReadStream(remotePath, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      result += chunk
      if (Buffer.byteLength(result) > MAX_AUTHORIZED_KEYS_SIZE) {
        stream.destroy(new Error('远程 authorized_keys 文件过大'))
      }
    })
    stream.once('error', (error) => {
      if (isMissingRemoteFile(error)) resolve(null)
      else reject(error)
    })
    stream.once('end', () => resolve(result))
  })
}

function appendRemoteFile(sftp, remotePath, contents, { exists }) {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(remotePath, {
      flags: exists ? 'a' : 'w',
      encoding: 'utf8',
      mode: 0o600,
    })
    stream.once('error', reject)
    stream.once('close', resolve)
    stream.end(contents)
  })
}

async function installAuthorizedKey(sftp, publicKey) {
  const home = await sftpCall(sftp, 'realpath', '.')
  const sshDirectory = `${String(home).replace(/[\\/]+$/, '')}/.ssh`
  const authorizedKeys = `${sshDirectory}/authorized_keys`
  try {
    await sftpCall(sftp, 'stat', sshDirectory)
  } catch (error) {
    if (!isMissingRemoteFile(error)) throw error
    await sftpCall(sftp, 'mkdir', sshDirectory, { mode: 0o700 })
  }

  const existing = await readRemoteFile(sftp, authorizedKeys)
  const normalizedKey = publicKey.trim()
  const alreadyInstalled = (existing ?? '').split(/\r?\n/).some((line) => line.trim() === normalizedKey)
  if (!alreadyInstalled) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    await appendRemoteFile(sftp, authorizedKeys, `${prefix}${normalizedKey}\n`, { exists: existing !== null })
  }
  await sftpCall(sftp, 'chmod', sshDirectory, 0o700).catch(() => undefined)
  await sftpCall(sftp, 'chmod', authorizedKeys, 0o600).catch(() => undefined)
}

function pairingError(error) {
  const message = String(error?.message ?? '').toLowerCase()
  if (message.includes('all configured authentication methods failed') || message.includes('authentication failure')) {
    return new Error('SSH 用户名或密码不正确')
  }
  if (error?.level === 'client-authentication') return new Error('SSH 用户名或密码不正确')
  if (error?.code === 'ECONNREFUSED') return new Error('SSH 连接被拒绝')
  if (error?.code === 'ETIMEDOUT' || error?.code === 'EHOSTUNREACH') return new Error('SSH 主机不可达')
  return new Error('SSH 配对失败')
}

function installKeyWithPassword(endpoint, password, publicKey, rawHostKey, {
  ClientCtor = Client,
  timeoutMs = 20_000,
} = {}) {
  const normalized = normalizeEndpoint(endpoint)
  if (!normalized.sshUser) return Promise.reject(new Error('首次配对需要填写 SSH 用户'))
  const host = normalizedSshHost(normalized.sshHost)
  const port = sshPort(normalized)
  return new Promise((resolve, reject) => {
    const client = new ClientCtor()
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch {}
      if (error) reject(pairingError(error))
      else resolve()
    }
    const timer = setTimeout(() => finish(new Error('SSH 配对超时')), timeoutMs)
    client.on('keyboard-interactive', (_name, _instructions, _language, prompts, complete) => {
      complete(prompts.map(() => password))
    })
    client.once('error', finish)
    client.once('ready', () => {
      client.sftp((error, sftp) => {
        if (error) return finish(error)
        installAuthorizedKey(sftp, publicKey).then(() => finish(), finish)
      })
    })
    try {
      client.connect({
        host,
        port,
        username: normalized.sshUser,
        password,
        tryKeyboard: true,
        readyTimeout: timeoutMs,
        hostVerifier: (key) => (
          key.length === rawHostKey.length && crypto.timingSafeEqual(Buffer.from(key), rawHostKey)
        ),
      })
    } catch (error) {
      finish(error)
    }
  })
}

class SshPairingService {
  constructor({
    storageDirectory,
    knownHostsPath,
    scan = scanHostKey,
    install = installKeyWithPassword,
    run = runCommand,
    resolve = resolveSshEndpoint,
    fsImpl = fs,
  }) {
    this.storageDirectory = storageDirectory
    this.identityFile = path.join(storageDirectory, 'id_ed25519')
    this.publicKeyFile = `${this.identityFile}.pub`
    this.knownHostsPath = knownHostsPath
    this.scan = scan
    this.install = install
    this.run = run
    this.resolve = resolve
    this.fs = fsImpl
  }

  async inspect(endpoint) {
    const normalized = normalizeEndpoint(endpoint)
    const resolved = await this.resolve(normalized)
    const scanned = await this.scan(resolved)
    let contents = ''
    try {
      contents = await this.fs.promises.readFile(this.knownHostsPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('无法读取 SSH 主机信任记录')
    }
    const trusted = knownHostsContains(contents, scanned.host, scanned.port, scanned.rawKey)
    return Object.freeze({
      endpointId: normalized.id,
      host: scanned.host,
      port: scanned.port,
      target: `${resolved.sshUser}@${scanned.host}:${scanned.port}`,
      keyType: hostKeyType(scanned.rawKey),
      fingerprint: hostKeyFingerprint(scanned.rawKey),
      trusted,
      requiresPairing: !trusted,
    })
  }

  async ensureIdentity() {
    if (this.fs.existsSync(this.identityFile) && this.fs.existsSync(this.publicKeyFile)) return
    await this.fs.promises.mkdir(this.storageDirectory, { recursive: true, mode: 0o700 })
    await this.run('ssh-keygen', [
      '-q', '-t', 'ed25519', '-N', '', '-C', 'dsh-tunnel-client', '-f', this.identityFile,
    ], {
      timeoutMessage: 'SSH 密钥生成超时',
      failureMessage: '无法生成客户端 SSH 密钥',
    })
    await this.fs.promises.chmod(this.identityFile, 0o600).catch(() => undefined)
    await this.fs.promises.chmod(this.publicKeyFile, 0o644).catch(() => undefined)
  }

  async pair(endpoint, { password, approvedFingerprint }) {
    const normalized = normalizeEndpoint(endpoint)
    if (typeof password !== 'string' || password.length === 0) throw new Error('请输入 SSH 登录密码')
    if (password.length > MAX_PASSWORD_LENGTH) throw new Error('SSH 登录密码太长')
    if (typeof approvedFingerprint !== 'string' || approvedFingerprint.length === 0) {
      throw new Error('请确认 SSH 主机指纹')
    }
    const resolved = await this.resolve(normalized)
    const scanned = await this.scan(resolved)
    const fingerprint = hostKeyFingerprint(scanned.rawKey)
    if (fingerprint !== approvedFingerprint) throw new Error('SSH 主机指纹已变化，请重新确认')

    await this.ensureIdentity()
    const publicKey = await this.fs.promises.readFile(this.publicKeyFile, 'utf8')
    await this.install(resolved, password, publicKey, scanned.rawKey)
    await this.trust(scanned)
    return Object.freeze({ paired: true, fingerprint })
  }

  async trust(scanned) {
    const directory = path.dirname(this.knownHostsPath)
    await this.fs.promises.mkdir(directory, { recursive: true, mode: 0o700 })
    let contents = ''
    try {
      contents = await this.fs.promises.readFile(this.knownHostsPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('无法读取 SSH 主机信任记录')
    }
    if (!knownHostsContains(contents, scanned.host, scanned.port, scanned.rawKey)) {
      const prefix = contents.length > 0 && !contents.endsWith('\n') ? '\n' : ''
      await this.fs.promises.appendFile(
        this.knownHostsPath,
        `${prefix}${knownHostsLine(scanned.host, scanned.port, scanned.rawKey)}\n`,
        { encoding: 'utf8', mode: 0o600 },
      )
    }
    await this.fs.promises.chmod(this.knownHostsPath, 0o600).catch(() => undefined)
  }
}

module.exports = {
  SshPairingService,
  hostKeyFingerprint,
  hostKeyType,
  hostToken,
  installAuthorizedKey,
  knownHostsContains,
  knownHostsLine,
  normalizedSshHost,
  parseSshConfigOutput,
  readSshString,
  resolveSshEndpoint,
  scanHostKey,
}
