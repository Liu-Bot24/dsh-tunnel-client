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

function loadClient(href, { popup = true, producedPaths = ['demo.html'] } = {}) {
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
      return { ProducedFiles, producedForClosing: () => producedPaths }
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
  const fileMentions = { forClosing: () => undefined }
  const effects = []
  let registration
  const ctx = {
    get: name => name === 'connection' ? connection : fileMentions,
    effect(callback) {
      effects.push(callback())
    },
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) {
        registration = { options, component }
        return () => {}
      },
    },
  }
  plugin.apply(ctx)
  return { assigned, effects, fileMentions, opened, plugin, registration, rpcCalls }
}

test('does not register any UI contribution on an unmarked local page', () => {
  const runtime = loadClient('http://127.0.0.1:3080/')
  assert.equal(runtime.registration, undefined)
})

test('registers on the fragment marker preserved by the RC.1 token redirect', () => {
  const runtime = loadClient('http://127.0.0.1:13080/#dsh_tunnel_preview=web')
  assert.ok(runtime.registration)
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

test('routes browser-native image extensions through the remote preview page', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  const native = []
  const rendered = runtime.registration.component({ sessionId: 'one', openFile: path => native.push(path) })
  for (const filename of ['photo.png', 'photo.jpg', 'photo.jpeg', 'photo.webp', 'photo.gif', 'photo.avif']) {
    rendered.props.openFile(filename)
  }
  assert.equal(runtime.opened.length, 6)
  assert.deepEqual(native, [])
})

test('routes produced-file mentions in closing prose through the same remote preview page', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  const native = []
  runtime.registration.component({ sessionId: 'one', openFile: path => native.push(path) })
  const mentions = runtime.fileMentions.forClosing({
    turn: { data: { get: () => ({}) } },
    seq: 1,
    openFile: path => native.push(path),
  })
  const mention = mentions.resolve('demo.html')
  assert.equal(mention.title, 'demo.html')
  mention.open()
  assert.equal(runtime.opened.length, 1)
  assert.deepEqual(native, [])
  const openedUrl = new URL(runtime.opened[0].url)
  assert.equal(openedUrl.searchParams.get('dsh_tunnel_preview'), 'web')
  assert.ok(openedUrl.searchParams.has('dsh_artifact_preview'))
})

test('routes one unique relative-path mention to its absolute produced file', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', {
    producedPaths: ['/workspace/pelican-bicycle/index.html'],
  })
  runtime.registration.component({ sessionId: 'one', openFile: () => {} })
  const mentions = runtime.fileMentions.forClosing({
    turn: { data: { get: () => ({}) } },
    seq: 1,
    openFile: () => {},
  })
  const mention = mentions.resolve('pelican-bicycle/index.html')
  assert.equal(mention.title, '/workspace/pelican-bicycle/index.html')
  mention.open()
  const requestUrl = new URL(runtime.opened[0].url)
  assert.ok(requestUrl.searchParams.has('dsh_artifact_preview'))
})

test('keeps an ambiguous relative-path mention inert', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', {
    producedPaths: [
      '/workspace/first/pelican-bicycle/index.html',
      '/workspace/second/pelican-bicycle/index.html',
    ],
  })
  runtime.registration.component({ sessionId: 'one', openFile: () => {} })
  const mentions = runtime.fileMentions.forClosing({
    turn: { data: { get: () => ({}) } },
    seq: 1,
    openFile: () => {},
  })
  assert.equal(mentions.resolve('pelican-bicycle/index.html'), undefined)
  assert.equal(runtime.opened.length, 0)
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
