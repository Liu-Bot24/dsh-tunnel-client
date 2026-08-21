const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const absoluteHomePattern = /(?:\/Users\/[A-Za-z0-9._-]+|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+)/
const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z][A-Z0-9.-]*\.[A-Z]{2,}\b/i

function read(filename) {
  return fs.readFileSync(path.join(projectRoot, filename), 'utf8')
}

test('new endpoint fields use generic placeholders without saved values', () => {
  const html = read('src/renderer/index.html')
  const placeholders = {
    'endpoint-name': '例如：工作电脑',
    'ssh-host': 'IP 地址或域名',
    'ssh-user': '可不填',
    'ssh-port': '22',
  }

  for (const [id, placeholder] of Object.entries(placeholders)) {
    const input = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0]
    assert.ok(input, `missing input: ${id}`)
    assert.match(input, new RegExp(`\\splaceholder="${placeholder}"`))
    assert.doesNotMatch(input, /\svalue=/)
  }
})

test('toolbar stays simple while local DSH actions remain in the detail view', () => {
  const html = read('src/renderer/index.html')
  const app = read('src/renderer/app.js')
  assert.match(html, /id="add-endpoint"[^>]*>[^<]*<span[^>]*>＋<\/span>添加主机<\/button>/)
  assert.match(html, /id="edit-endpoint"[^>]*>编辑<\/button>/)
  assert.match(html, /id="stop-tunnel"[^>]*>断开<\/button>/)
  assert.match(html, /id="primary-endpoint-action"[^>]*>连接并打开<\/button>/)
  assert.match(app, /primaryActionButton\.textContent = '启动并打开'/)
  assert.match(app, /primaryActionButton\.textContent = '打开 WebUI'/)
  assert.doesNotMatch(html, /type="radio" name="endpoint-mode"/)
  assert.doesNotMatch(html, /toggle-local-dsh|local-dsh-menu|open-local-webui/)
  assert.doesNotMatch(html, /FRP|field-help|form-hint|映射端口|本客户端|那台电脑/)
})

test('endpoint help copy describes fields without workflow-specific instructions', () => {
  const html = read('src/renderer/index.html')
  for (const copy of [
    '仅用于本机识别。',
    '也可使用 SSH 配置中的别名。',
    '留空时使用 SSH 默认值。',
    '留空则使用 SSH 配置或 22。',
    'SSH 目标侧可访问的 DSH 端口。',
    '本机浏览器访问 DSH 时使用的端口。',
  ]) {
    assert.match(html, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.doesNotMatch(html, /FRP|映射端口|转发 DSH|填写服务器/)
})

test('tracked product text avoids user-home paths and email addresses', () => {
  const filenames = [
    'README.md',
    'package.json',
    'scripts/package-mac.mjs',
    'scripts/render-tray-icons.cjs',
    'src/main.cjs',
    'src/core/endpoint.cjs',
    'src/core/local-dsh-manager.cjs',
    'src/core/store.cjs',
    'src/core/tray-menu.cjs',
    'src/core/tunnel-manager.cjs',
    'src/renderer/index.html',
    'src/renderer/app.js',
    'src/renderer/user-message.js',
    'resources/app-icon.svg',
  ]

  assert.match(['/Users', 'example', 'project'].join('/'), absoluteHomePattern)
  assert.doesNotMatch('src/renderer/index.html', absoluteHomePattern)
  assert.match(['person', 'example.test'].join('@'), emailPattern)
  assert.doesNotMatch('SSH config 中的 Host 别名', emailPattern)

  for (const filename of filenames) {
    const contents = read(filename)
    assert.doesNotMatch(contents, absoluteHomePattern, `${filename} contains an absolute user-home path`)
    assert.doesNotMatch(contents, emailPattern, `${filename} contains an email address`)
  }
})
