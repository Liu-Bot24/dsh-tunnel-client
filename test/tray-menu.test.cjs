const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { buildTrayMenuTemplate } = require('../src/core/tray-menu.cjs')

const local = { id: 'local-dsh', mode: 'local', name: '本机 DSH' }
const remote = { id: 'remote-one', mode: 'ssh', name: '工作电脑' }

test('offers local launch and a clear empty remote state', () => {
  const menu = buildTrayMenuTemplate({ endpoints: [local] })
  assert.deepEqual(menu[2].submenu.map((item) => item.label), ['启动并打开'])
  assert.deepEqual(menu[3].submenu, [{ label: '没有远程主机', enabled: false }])
})

test('offers open and stop only for a locally owned DSH process', () => {
  const owned = buildTrayMenuTemplate({
    endpoints: [local],
    localState: { state: 'running', owned: true },
  })
  assert.deepEqual(owned[2].submenu.map((item) => item.label), ['打开 WebUI', '停止'])

  const external = buildTrayMenuTemplate({
    endpoints: [local],
    localState: { state: 'running', owned: false },
  })
  assert.deepEqual(external[2].submenu.map((item) => item.label), ['打开 WebUI', '由其他程序启动'])
  assert.equal(external[2].submenu[1].enabled, false)
})

test('remote actions follow tunnel state and preserve the endpoint id', () => {
  const calls = []
  const actions = {
    connectAndOpen: (id) => calls.push(['connect', id]),
    openRemote: (id) => calls.push(['open', id]),
    disconnectRemote: (id) => calls.push(['disconnect', id]),
  }
  const stopped = buildTrayMenuTemplate({ endpoints: [local, remote], actions })
  stopped[3].submenu[0].submenu[0].click()

  const connected = buildTrayMenuTemplate({
    endpoints: [local, remote],
    tunnelStates: [{ endpointId: remote.id, state: 'connected' }],
    actions,
  })
  assert.deepEqual(connected[3].submenu[0].submenu.map((item) => item.label), ['打开 DSH', '断开'])
  connected[3].submenu[0].submenu[0].click()
  connected[3].submenu[0].submenu[1].click()
  assert.deepEqual(calls, [
    ['connect', remote.id],
    ['open', remote.id],
    ['disconnect', remote.id],
  ])
})

test('offers retry actions when a live process failed to stop', () => {
  const actions = {
    stopLocal: () => {},
    disconnectRemote: () => {},
  }
  const menu = buildTrayMenuTemplate({
    endpoints: [local, remote],
    localState: { state: 'error', owned: true },
    tunnelStates: [{ endpointId: remote.id, state: 'error', active: true }],
    actions,
  })
  assert.equal(menu[2].submenu[0].label, '重试停止')
  assert.equal(menu[3].submenu[0].submenu[0].label, '重试断开')
})

test('desktop lifecycle keeps one tray instance and only hides the window on macOS', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../src/main.cjs'), 'utf8')
  assert.match(main, /app\.requestSingleInstanceLock\(\)/)
  assert.match(main, /window\.on\('close', \(event\) =>/)
  assert.match(main, /process\.platform !== 'darwin'/)
  assert.match(main, /event\.preventDefault\(\)[\s\S]*window\.hide\(\)/)
  assert.match(main, /window-all-closed[\s\S]*process\.platform !== 'darwin'[\s\S]*app\.quit\(\)/)
  assert.match(main, /app\.on\('second-instance', showMainWindow\)/)
})
