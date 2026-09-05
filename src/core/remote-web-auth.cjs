const fs = require('node:fs')
const { spawn } = require('node:child_process')
const { normalizeEndpoint } = require('./endpoint.cjs')
const { sshTarget } = require('./ssh.cjs')
const { HANDOFF_VERSION, authenticatedWebUrl } = require('./web-auth.cjs')

const MAX_HANDOFF_BYTES = 4_096

// Use the same OpenSSH authentication/configuration as the forwarding process.
// A fixed `node -` command works on both host platforms; the small read script
// travels over stdin, and the launch URL stays only in bounded process memory.
function readRemoteWebAuthUrl(input, {
  identityFile,
  knownHostsPath,
  spawnProcess = spawn,
  fsImpl = fs,
  timeoutMs = 10_000,
} = {}) {
  const endpoint = normalizeEndpoint(input)
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10']
  if (identityFile && fsImpl.existsSync(identityFile)) args.push('-i', identityFile)
  if (knownHostsPath) args.push('-o', `UserKnownHostsFile=${knownHostsPath}`)
  if (endpoint.sshPort !== null) args.push('-p', String(endpoint.sshPort))
  args.push(sshTarget(endpoint), 'node', '-')
  const script = `const fs = require('node:fs');
const path = require('node:path');
const filename = path.join(require('node:os').homedir(), '.dsh-tunnel', 'web-auth-${endpoint.remotePort}.json');
try {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.size > ${MAX_HANDOFF_BYTES}) process.exit(2);
  process.stdout.write(fs.readFileSync(filename));
} catch (error) { process.exit(error.code === 'ENOENT' ? 0 : 1); }
`
  return new Promise((resolve, reject) => {
    let child
    let settled = false
    let body = ''
    const finish = (error, value = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        child?.kill()
        reject(new Error('无法读取远端 DSH 认证信息'))
      } else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('timeout')), timeoutMs)
    try {
      child = spawnProcess('ssh', args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      child.once('error', finish)
      child.stdin.on?.('error', finish)
      child.stdout.on('data', chunk => {
        if (settled) return
        if (Buffer.byteLength(body) + Buffer.byteLength(chunk) > MAX_HANDOFF_BYTES) {
          finish(new Error('oversized handoff'))
          return
        }
        body += String(chunk)
      })
      // Drain diagnostics without retaining or exposing authentication details.
      child.stderr.resume()
      child.once('close', code => {
        if (settled) return
        if (code !== 0) return finish(new Error('ssh failed'))
        if (!body.trim()) return finish(null)
        try {
          const parsed = JSON.parse(body)
          const url = parsed?.version === HANDOFF_VERSION && parsed?.port === endpoint.remotePort
            ? authenticatedWebUrl(parsed.url, endpoint.remotePort)
            : null
          finish(null, url)
        } catch { finish(new Error('invalid handoff')) }
      })
      child.stdin.end(script)
    } catch (error) { finish(error) }
  })
}

module.exports = { MAX_HANDOFF_BYTES, readRemoteWebAuthUrl }
