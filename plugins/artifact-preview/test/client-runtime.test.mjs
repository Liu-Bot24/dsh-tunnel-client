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

function loadClient(href, { popup = true, producedPaths = ['demo.html'], connectionVersion = 'rc2', nativeMentions = () => undefined, nativeCapability = null } = {}) {
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
    ...(connectionVersion === 'rc2' ? { hostDescription: {} } : {}),
    rpc: {
      call(channel, endpoint, payload) {
        rpcCalls.push({ channel, endpoint, payload })
        return new Promise(() => {})
      },
    },
  }
  const fileMentions = { forClosing: nativeMentions }
  const effects = []
  let registration
  const ctx = {
    get: name => name === 'connection' ? connection : fileMentions,
    inject(names, callback) {
      if (nativeCapability) callback({
        get(name) { return nativeCapability[name] },
        effect(callback) { effects.push(callback()) },
      })
    },
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
  // Exercise the framework's observable binding before mounting, rather than
  // letting an undefined source pass because the component is mocked.
  function mountProduced(props) {
    const injected = registration.options.inject?.(props.sessionId) ?? {}
    const bound = { ...injected }
    for (const [name, source] of Object.entries(injected.hooks ?? {})) {
      new WeakMap().set(source, true)
      bound[`use${name[0].toUpperCase()}${name.slice(1)}`] = select => select(source.getSnapshot?.())
    }
    const rendered = registration.component({ ...props, ...bound })
    // Both real upstream components call these even with isLoopback=false.
    if (connectionVersion === 'rc1') {
      rendered.props.ensureWorkspacePathOpen()
      rendered.props.useWorkspacePathOpen(value => value === true)
    } else {
      rendered.props.useHostDescription(value => value?.canOpenPath === true)
    }
    return rendered
  }
  return { assigned, effects, fileMentions, opened, plugin, registration, rpcCalls, mountProduced }
}

function turnOwner(openFile = () => {}) {
  return { turn: { data: { get: () => ({}) } }, seq: 1, openFile }
}

test('mounts the RC.1 capability contract without a legacy hostDescription source', () => {
  const runtime = loadClient('http://127.0.0.1:13080/#dsh_tunnel_preview=web', { connectionVersion: 'rc1' })
  const rendered = runtime.mountProduced({ ...turnOwner(), sessionId: 'rc1-session' })
  rendered.props.openFile('demo.html')
  const request = JSON.parse(Buffer.from(new URL(runtime.opened[0].url).searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.kind, 'preview')
  assert.equal(request.sessionId, 'rc1-session')
})

test('keeps the RC.2 produced-files component contract working', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  assert.equal(runtime.mountProduced({ ...turnOwner(), sessionId: 'rc2-session' }).props.isLoopback, false)
})

test('prose previews keep their owning session across interleaved renders', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  const first = turnOwner()
  const second = turnOwner()
  const firstMention = runtime.fileMentions.forClosing(first).resolve('demo.html')
  runtime.registration.component({ ...first, sessionId: 'first' })
  runtime.registration.component({ ...second, sessionId: 'second' })
  firstMention.open()
  const request = JSON.parse(Buffer.from(new URL(runtime.opened[0].url).searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.sessionId, 'first')
})

test('a prose owner with no session binding cannot borrow another turn session', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  runtime.registration.component({ ...turnOwner(), sessionId: 'other' })
  runtime.fileMentions.forClosing(turnOwner()).resolve('demo.html').open()
  const request = JSON.parse(Buffer.from(new URL(runtime.opened[0].url).searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.kind, 'error')
  assert.equal(request.sessionId, undefined)
})

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
  const owner = turnOwner(path => native.push(path))
  runtime.registration.component({ ...owner, sessionId: 'one' })
  const mentions = runtime.fileMentions.forClosing(owner)
  const mention = mentions.resolve('demo.html')
  assert.equal(mention.title, 'demo.html')
  mention.open()
  assert.equal(runtime.opened.length, 1)
  assert.deepEqual(native, [])
  const openedUrl = new URL(runtime.opened[0].url)
  assert.equal(openedUrl.searchParams.get('dsh_tunnel_preview'), 'web')
  const request = JSON.parse(Buffer.from(openedUrl.searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.kind, 'preview')
  assert.equal(request.sessionId, 'one')
  assert.equal(request.producedPath, 'demo.html')
})

test('routes one unique relative-path mention to its absolute produced file', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', {
    producedPaths: ['/workspace/pelican-bicycle/index.html'],
  })
  const owner = turnOwner()
  runtime.registration.component({ ...owner, sessionId: 'one' })
  const mentions = runtime.fileMentions.forClosing(owner)
  const mention = mentions.resolve('pelican-bicycle/index.html')
  assert.equal(mention.title, '/workspace/pelican-bicycle/index.html')
  mention.open()
  const requestUrl = new URL(runtime.opened[0].url)
  const request = JSON.parse(Buffer.from(requestUrl.searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.kind, 'preview')
  assert.equal(request.sessionId, 'one')
  assert.equal(request.producedPath, '/workspace/pelican-bicycle/index.html')
})

test('keeps an ambiguous relative-path mention inert', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', {
    producedPaths: [
      '/workspace/first/pelican-bicycle/index.html',
      '/workspace/second/pelican-bicycle/index.html',
    ],
  })
  const owner = turnOwner()
  runtime.registration.component({ ...owner, sessionId: 'one' })
  const mentions = runtime.fileMentions.forClosing(owner)
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


test('keeps new declared-file cards and forwards their session to the native mention resolver', () => {
  const calls = []
  const native = { resolve: () => 'native-declared-file' }
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web', { nativeMentions: (...args) => { calls.push(args); return native } })
  const owner = { turn: { data: { get: () => ({ presented: [{ seq: 2, path: 'demo.html' }] }) } }, seq: 3, openFile() {} }
  assert.equal(runtime.registration.options.select(owner), null)
  assert.equal(runtime.fileMentions.forClosing(owner, 'declared-session'), native)
  assert.equal(calls[0][1], 'declared-session')
  owner.seq = 1
  assert.deepEqual(Array.from(runtime.registration.options.select(owner)), ['demo.html'])
})

test('uses the explicit new session argument without borrowing a previously mounted turn', () => {
  const runtime = loadClient('http://127.0.0.1:13080/?dsh_tunnel_preview=web')
  runtime.fileMentions.forClosing(turnOwner(), 'explicit-session').resolve('demo.html').open()
  const request = JSON.parse(Buffer.from(new URL(runtime.opened[0].url).searchParams.get('dsh_artifact_preview'), 'base64url'))
  assert.equal(request.sessionId, 'explicit-session')
})

function modernPreview(extensions = ['html', 'svg', 'png']) {
  return {
    sidebarRight: { openResource() {} },
    sidebarRightTabs: { get: () => ({ id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview' }) },
    documentPreviews: { candidates: path => extensions.some(ext => path.endsWith('.' + ext)) ? [{ loading: 'bytes-complete' }] : [] },
    remote: { workspaceFiles: { readAll() {} } },
  }
}

test('modern supported files preserve the native turn contribution and prose resolver', () => {
  const native = { resolve() {} }
  const runtime = loadClient('http://127.0.0.1:13080/#dsh_tunnel_preview=web', { nativeCapability: modernPreview(), nativeMentions: () => native })
  assert.equal(runtime.registration.options.select(turnOwner()), null)
  assert.equal(runtime.fileMentions.forClosing(turnOwner(), 'modern'), native)
  const opened = []
  runtime.registration.component({ sessionId: 'modern', openFile: path => opened.push(path) }).props.openFile('demo.html')
  assert.deepEqual(opened, ['demo.html'])
  assert.equal(runtime.opened.length, 0)
})

test('sidebar presence alone does not disable legacy preview and unsupported formats still fall back', () => {
  const incomplete = modernPreview(); incomplete.remote = { workspaceFiles: {} }
  for (const nativeCapability of [incomplete, modernPreview(['pdf'])]) {
    const runtime = loadClient('http://127.0.0.1:13080/#dsh_tunnel_preview=web', { nativeCapability })
    assert.ok(runtime.registration.options.select(turnOwner()))
    runtime.registration.component({ sessionId: 'one', openFile() { assert.fail('unsupported native') } }).props.openFile('demo.html')
    assert.equal(runtime.opened.length, 1)
  }
})

test('mixed files preserve native supported opening and do not hide native errors', () => {
  const runtime = loadClient('http://127.0.0.1:13080/#dsh_tunnel_preview=web', { nativeCapability: modernPreview(), producedPaths: ['demo.html', 'image.avif'] })
  assert.ok(runtime.registration.options.select(turnOwner()))
  const rendered = runtime.registration.component({ sessionId: 'one', openFile() { throw new Error('native read failed') } })
  assert.throws(() => rendered.props.openFile('demo.html'), /native read failed/)
  assert.equal(runtime.opened.length, 0)
  rendered.props.openFile('image.avif')
  assert.equal(runtime.opened.length, 1)
})
