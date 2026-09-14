const http = require('node:http')
const { authenticatedWebUrl, DSH_AUTH_REQUIRED_BODY } = require('./web-auth.cjs')

const LINK_UNAVAILABLE = '无法获取有效访问链接，请从启动 DSH 的终端获取当前链接'

function requestPage(url, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: cookie ? { cookie } : {} }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => {
        body += chunk
        if (body.length > 1024 * 1024) request.destroy(new Error('oversized response'))
      })
      response.on('error', reject)
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }))
    })
    // A total deadline also bounds a server that keeps sending small chunks.
    const timer = setTimeout(() => request.destroy(new Error('timeout')), 4000)
    request.on('close', () => clearTimeout(timer))
    request.on('error', reject)
  })
}

async function resolveAccessLink({ port, cachedUrl = null, readFreshUrl = async () => null, preview = false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DSH 端口不可用')
  const base = `http://127.0.0.1:${port}/`
  const decorate = value => {
    const url = new URL(value)
    if (preview) url.hash = 'dsh_tunnel_preview=web'
    return url.toString()
  }
  let root
  try { root = await requestPage(base) } catch { throw new Error('DSH 没有响应') }
  if (root.status === 200 && root.body.includes('<title>DeepSeek Harness</title>')) return decorate(base)
  if (root.status !== 401 || !root.body.includes(DSH_AUTH_REQUIRED_BODY)) throw new Error('当前端口不是可用的 DSH 服务')
  async function accepted(value) {
    if (!value) return null
    // The preview marker is a client-only fragment, never an authentication input.
    let candidate
    try { candidate = new URL(value); candidate.hash = '' } catch { return null }
    const valid = authenticatedWebUrl(candidate.toString(), port)
    if (!valid) return null
    // Keep both the exchange and subsequent cookie check on the same authority.
    const local = new URL(valid); local.hostname = '127.0.0.1'
    try {
      const exchange = await requestPage(local)
      if (exchange.status !== 303 || exchange.headers.location !== '/') return null
      const cookie = exchange.headers['set-cookie']?.map(value => value.split(';', 1)[0]).join('; ')
      if (!cookie) return null
      const page = await requestPage(base, cookie)
      return page.status === 200 && page.body.includes('<title>DeepSeek Harness</title>') ? decorate(local) : null
    } catch { return null }
  }
  const cached = await accepted(cachedUrl)
  if (cached) return cached
  let fresh
  try { fresh = await readFreshUrl() } catch { throw new Error(LINK_UNAVAILABLE) }
  const resolved = await accepted(fresh)
  if (!resolved) throw new Error(LINK_UNAVAILABLE)
  return resolved
}

module.exports = { resolveAccessLink, LINK_UNAVAILABLE }
