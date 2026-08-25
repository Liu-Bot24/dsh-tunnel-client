import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const generated = await readFile(new URL('../client.js', import.meta.url), 'utf8')

function fakeDocument() {
  const node = () => ({
    append() {},
    setAttribute() {},
    replaceChildren() {},
    textContent: '',
  })
  return {
    createElement: node,
    head: node(),
    body: node(),
    documentElement: { lang: '' },
  }
}

function loadClient(href, { popup = true } = {}) {
  let definition
  const opened = []
  const assigned = []
  const rpcCalls = []
  const parsedLocation = new URL(href)
  const location = {
    href: parsedLocation.href,
    hash: parsedLocation.hash,
    assign(url) {
      assigned.push(url)
      this.href = url
      this.hash = new URL(url).hash
    },
  }
  const context = {
    URL,
    URLSearchParams,
    TextDecoder,
    TextEncoder,
    Uint8Array,
    atob,
    btoa,
    navigator: { language: 'zh-CN' },
    window: {
      document: fakeDocument(),
      location,
      __ModuleLoader__: { load(value) { definition = value } },
      open(url, name, features) {
        if (!popup) return null
        const target = { closed: false, document: fakeDocument(), focus() {}, opener: {} }
        opened.push({ url, name, features, target })
        return target
      },
    },
  }
  vm.runInNewContext(generated, context)

  const React = { createElement: (component, props) => ({ component, props }) }
  const ProducedFiles = () => null
  const plugin = definition.factory(id => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-deliverables/client') {
      return { ProducedFiles, producedForClosing: () => ['demo.html'] }
    }
    throw new Error(`unexpected module ${id}`)
  })
  const connection = {
    hostDescription: {},
    rpc: {
      call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, payload })
        return new Promise(() => {})
      },
    },
  }
  let registration
  const ctx = {
    get: () => connection,
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { assigned, opened, plugin, registration, rpcCalls }
}

test('does not register any UI contribution on an unmarked local page', () => {
  const runtime = loadClient('http://127.0.0.1:3080/')
  assert.equal(runtime.registration, undefined)
})

test('keeps native files on the stock opener and opens a same-origin preview URL in a new tab', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  assert.equal(runtime.registration.options.priority, -100)
  const native = []
  const rendered = runtime.registration.component({ sessionId: 'one', openFile: path => native.push(path) })

  rendered.props.openFile('notes.txt')
  assert.deepEqual(native, ['notes.txt'])
  assert.equal(runtime.opened.length, 0)

  rendered.props.openFile('demo.html')
  assert.equal(runtime.opened.length, 1)
  assert.equal(runtime.assigned.length, 0)
  assert.equal(runtime.rpcCalls.length, 0)
  assert.equal(runtime.opened[0].name, '_blank')
  assert.equal(runtime.opened[0].features, 'noopener,noreferrer')
  const openedUrl = new URL(runtime.opened[0].url)
  assert.equal(openedUrl.origin, 'http://127.0.0.1:13080')
  assert.equal(openedUrl.searchParams.get('dsh_tunnel_preview'), 'web')
  assert.ok(openedUrl.searchParams.has('dsh_artifact_preview'))
  assert.equal(openedUrl.hash, '')

  const preview = loadClient(openedUrl.href)
  assert.equal(preview.registration, undefined)
  assert.equal(preview.rpcCalls.length, 1)
  assert.equal(preview.rpcCalls[0].payload.sessionId, 'one')
  assert.equal(preview.rpcCalls[0].payload.producedPath, 'demo.html')
})

test('never replaces the conversation tab when a popup is unavailable', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', { popup: false })
  const native = []
  const rendered = runtime.registration.component({ sessionId: 'one', openFile: path => native.push(path) })
  rendered.props.openFile('demo.html')
  assert.equal(runtime.rpcCalls.length, 0)
  assert.equal(runtime.assigned.length, 0)
  assert.equal(runtime.opened.length, 0)
  assert.deepEqual(native, [])
})

test('opens each preview request without falling back to native open', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  const native = []
  const rendered = runtime.registration.component({ sessionId: 'one', openFile: path => native.push(path) })
  for (let index = 0; index < 6; index += 1) rendered.props.openFile(`demo-${index}.html`)
  assert.equal(runtime.rpcCalls.length, 0)
  assert.equal(runtime.opened.length, 6)
  assert.equal(runtime.assigned.length, 0)
  assert.match(runtime.opened.at(-1).url, /[?&]dsh_artifact_preview=/u)
  assert.deepEqual(native, [])
})
