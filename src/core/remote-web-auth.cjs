const fs = require('node:fs')
const { Client } = require('ssh2')
const { normalizeEndpoint } = require('./endpoint.cjs')
const {
  knownHostsContains,
  normalizedSshHost,
  resolveSshEndpoint,
} = require('./ssh-pairing.cjs')
const {
  HANDOFF_VERSION,
  authenticatedWebUrl,
  remoteHandoffPath,
} = require('./web-auth.cjs')

const MAX_HANDOFF_BYTES = 4_096

function readSftpText(sftp, filename, maximum = MAX_HANDOFF_BYTES) {
  return new Promise((resolve, reject) => {
    let settled = false
    let body = ''
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error) reject(error)
      else resolve(value)
    }
    const stream = sftp.createReadStream(filename, { encoding: 'utf8' })
    stream.on('data', (chunk) => {
      body += String(chunk)
      if (Buffer.byteLength(body) > maximum) {
        stream.destroy(new Error('远端 DSH 认证信息过大'))
      }
    })
    stream.once('error', (error) => {
      if (error?.code === 2 || error?.code === 'ENOENT' || /no such file/iu.test(error?.message ?? '')) {
        finish(null, null)
      } else {
        finish(error)
      }
    })
    stream.once('end', () => finish(null, body))
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

async function readRemoteWebAuthUrl(input, {
  identityFile,
  knownHostsPath,
  ClientCtor = Client,
  fsImpl = fs,
  resolve = resolveSshEndpoint,
  timeoutMs = 10_000,
} = {}) {
  if (!identityFile || !knownHostsPath) return null
  const endpoint = normalizeEndpoint(input)
  let privateKey
  let knownHosts
  try {
    [privateKey, knownHosts] = await Promise.all([
      fsImpl.promises.readFile(identityFile),
      fsImpl.promises.readFile(knownHostsPath, 'utf8'),
    ])
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw new Error('无法读取 SSH 认证信息')
  }

  const resolved = await resolve(endpoint)
  const host = normalizedSshHost(resolved.sshHost)
  const port = resolved.sshPort ?? 22
  return new Promise((resolvePromise, rejectPromise) => {
    const client = new ClientCtor()
    let settled = false
    const finish = (error, value = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { client.end() } catch {}
      if (error) rejectPromise(new Error('无法读取远端 DSH 认证信息'))
      else resolvePromise(value)
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    client.once('error', finish)
    client.once('ready', () => {
      client.sftp(async (error, sftp) => {
        if (error) return finish(error)
        try {
          const home = await sftpCall(sftp, 'realpath', '.')
          const body = await readSftpText(sftp, remoteHandoffPath(home, endpoint.remotePort))
          if (body === null) return finish(null, null)
          const parsed = JSON.parse(body)
          const url = parsed?.version === HANDOFF_VERSION
            && parsed?.port === endpoint.remotePort
            ? authenticatedWebUrl(parsed.url, endpoint.remotePort)
            : null
          finish(null, url)
        } catch (readError) {
          finish(readError)
        }
      })
    })
    try {
      client.connect({
        host,
        port,
        username: resolved.sshUser,
        privateKey,
        readyTimeout: timeoutMs,
        hostVerifier: key => knownHostsContains(knownHosts, host, port, Buffer.from(key)),
      })
    } catch (error) {
      finish(error)
    }
  })
}

module.exports = {
  MAX_HANDOFF_BYTES,
  readRemoteWebAuthUrl,
  readSftpText,
}
