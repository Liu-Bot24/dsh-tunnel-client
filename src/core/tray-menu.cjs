function buildTrayMenuTemplate({
  endpoints = [],
  tunnelStates = [],
  localState = { state: 'stopped', owned: false },
  actions = {},
} = {}) {
  const local = endpoints.find((endpoint) => endpoint.mode === 'local')
  const remoteEndpoints = endpoints.filter((endpoint) => endpoint.mode === 'ssh')
  const states = new Map(tunnelStates.map((state) => [state.endpointId, state]))

  return [
    { label: '显示 DSH Tunnel', click: actions.showWindow },
    { type: 'separator' },
    {
      label: local?.name ?? '本机 DSH',
      submenu: localMenu(localState, actions),
    },
    {
      label: '远程主机',
      submenu: remoteEndpoints.length > 0
        ? remoteEndpoints.map((endpoint) => ({
          label: endpoint.name,
          submenu: remoteMenu(endpoint, states.get(endpoint.id), actions),
        }))
        : [{ label: '没有远程主机', enabled: false }],
    },
    { type: 'separator' },
    { label: '退出 DSH Tunnel', click: actions.quit },
  ]
}

function localMenu(state, actions) {
  if (state.state === 'starting') return [{ label: '正在启动…', enabled: false }]
  if (state.state === 'stopping') return [{ label: '正在停止…', enabled: false }]
  if (state.state !== 'running') return [{ label: '启动并打开', click: actions.startLocalAndOpen }]

  const items = [{ label: '打开 WebUI', click: actions.openLocal }]
  if (state.owned) items.push({ label: '停止', click: actions.stopLocal })
  else items.push({ label: '由其他程序启动', enabled: false })
  return items
}

function remoteMenu(endpoint, state = { state: 'stopped' }, actions) {
  if (state.state === 'starting') return [{ label: '连接中…', enabled: false }]
  if (state.state === 'stopping') return [{ label: '断开中…', enabled: false }]
  if (state.state !== 'connected') {
    return [{ label: '连接并打开', click: () => actions.connectAndOpen?.(endpoint.id) }]
  }
  return [
    { label: '打开 DSH', click: () => actions.openRemote?.(endpoint.id) },
    { label: '断开', click: () => actions.disconnectRemote?.(endpoint.id) },
  ]
}

module.exports = { buildTrayMenuTemplate }
