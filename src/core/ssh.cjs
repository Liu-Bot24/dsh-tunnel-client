const { normalizeEndpoint } = require('./endpoint.cjs')

function sshTarget(endpoint) {
  return endpoint.sshUser === null ? endpoint.sshHost : `${endpoint.sshUser}@${endpoint.sshHost}`
}

function buildSshArgs(input) {
  const endpoint = normalizeEndpoint(input)
  if (endpoint.mode !== 'ssh') throw new Error('本机直连不需要 SSH 参数')
  const args = [
    '-N',
    '-T',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-L', `127.0.0.1:${endpoint.localPort}:127.0.0.1:${endpoint.remotePort}`,
  ]
  if (endpoint.sshPort !== null) args.push('-p', String(endpoint.sshPort))
  args.push(sshTarget(endpoint))
  return args
}

module.exports = { buildSshArgs, sshTarget }
