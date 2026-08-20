const supportedThemes = new Set([
  'whale-song',
  'nautical-chart',
  'phosphor',
  'bauhaus-signal',
  'soft-porcelain',
])
const themeLabels = {
  'whale-song': '深海鲸歌',
  'nautical-chart': '航海图纸',
  phosphor: '夜视终端',
  'bauhaus-signal': '包豪斯信号',
  'soft-porcelain': '柔雾器物',
}

const listElement = document.querySelector('#endpoint-list')
const sidebarEmptyElement = document.querySelector('#sidebar-empty')
const endpointCountElement = document.querySelector('#endpoint-count')
const emptyElement = document.querySelector('#empty-state')
const detailElement = document.querySelector('#endpoint-detail')
const noticeElement = document.querySelector('#notice')
const endpointDialog = document.querySelector('#endpoint-dialog')
const endpointForm = document.querySelector('#endpoint-form')
const settingsDialog = document.querySelector('#settings-dialog')
const settingsForm = document.querySelector('#settings-form')
const deleteButton = document.querySelector('#delete-endpoint')
const fields = {
  id: document.querySelector('#endpoint-id'),
  name: document.querySelector('#endpoint-name'),
  sshHost: document.querySelector('#ssh-host'),
  sshUser: document.querySelector('#ssh-user'),
  sshPort: document.querySelector('#ssh-port'),
  remotePort: document.querySelector('#remote-port'),
  localPort: document.querySelector('#local-port'),
}
const detailFields = {
  name: document.querySelector('#detail-name'),
  alias: document.querySelector('#detail-alias'),
  ssh: document.querySelector('#detail-ssh'),
  local: document.querySelector('#detail-local'),
  remote: document.querySelector('#detail-remote'),
  routeLocal: document.querySelector('#route-local'),
  routeRemote: document.querySelector('#route-remote'),
  status: document.querySelector('#detail-status'),
  error: document.querySelector('#endpoint-error'),
}
const primaryActionButton = document.querySelector('#primary-endpoint-action')
const stopButton = document.querySelector('#stop-tunnel')
const editButton = document.querySelector('#edit-endpoint')

let endpoints = []
let selectedEndpointId = null
let settings = { theme: 'whale-song' }
let settingsCommitted = false
let noticeTimer = null
const tunnelStates = new Map()

function showNotice(message, kind = 'error') {
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeElement.textContent = message
  noticeElement.dataset.kind = kind
  noticeElement.classList.remove('hidden')
  if (kind === 'success') noticeTimer = window.setTimeout(clearNotice, 2400)
}

function clearNotice() {
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = null
  noticeElement.classList.add('hidden')
  noticeElement.textContent = ''
}

function applyTheme(theme) {
  if (!supportedThemes.has(theme)) return
  document.documentElement.dataset.theme = theme
}

function statusLabel(state) {
  if (state === 'connected') return '已连接'
  if (state === 'starting') return '连接中'
  if (state === 'stopping') return '停止中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function selectedEndpoint() {
  return endpoints.find((endpoint) => endpoint.id === selectedEndpointId) ?? null
}

function stateFor(endpointId) {
  return tunnelStates.get(endpointId) ?? { state: 'stopped', error: null }
}

function sshTarget(endpoint) {
  const user = endpoint.sshUser ? `${endpoint.sshUser}@` : ''
  const port = endpoint.sshPort ? `:${endpoint.sshPort}` : ''
  return `${user}${endpoint.sshHost}${port}`
}

function renderEndpointList() {
  listElement.replaceChildren()
  endpointCountElement.textContent = String(endpoints.length)
  sidebarEmptyElement.classList.toggle('hidden', endpoints.length !== 0)

  for (const endpoint of endpoints) {
    const state = stateFor(endpoint.id)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'endpoint-row'
    row.setAttribute('role', 'option')
    row.setAttribute('aria-selected', String(endpoint.id === selectedEndpointId))
    row.addEventListener('click', () => {
      selectedEndpointId = endpoint.id
      render()
    })

    const dot = document.createElement('i')
    dot.className = `status-dot ${state.state}`
    const copy = document.createElement('span')
    copy.className = 'endpoint-row-copy'
    const name = document.createElement('span')
    name.className = 'endpoint-row-name'
    name.textContent = endpoint.name
    const meta = document.createElement('span')
    meta.className = 'endpoint-row-meta'
    meta.textContent = `${endpoint.sshHost} · ${statusLabel(state.state)}`
    copy.append(name, meta)
    row.append(dot, copy)
    listElement.append(row)
  }
}

function renderEndpointDetail() {
  const endpoint = selectedEndpoint()
  emptyElement.classList.toggle('hidden', endpoint !== null || endpoints.length !== 0)
  detailElement.classList.toggle('hidden', endpoint === null)
  if (endpoint === null) return

  const state = stateFor(endpoint.id)
  const busy = state.state === 'starting' || state.state === 'stopping'
  detailFields.name.textContent = endpoint.name
  detailFields.alias.textContent = `${endpoint.sshHost} · SSH`
  detailFields.ssh.textContent = sshTarget(endpoint)
  detailFields.local.textContent = `127.0.0.1:${endpoint.localPort}`
  detailFields.remote.textContent = `127.0.0.1:${endpoint.remotePort}`
  detailFields.routeLocal.textContent = `127.0.0.1:${endpoint.localPort}`
  detailFields.routeRemote.textContent = `127.0.0.1:${endpoint.remotePort}`
  detailFields.status.className = `status ${state.state}`
  detailFields.status.querySelector('span').textContent = statusLabel(state.state)
  detailFields.error.textContent = state.error ?? ''
  detailFields.error.classList.toggle('hidden', !state.error)

  primaryActionButton.disabled = busy
  if (state.state === 'connected') primaryActionButton.textContent = '打开 DSH'
  else if (state.state === 'starting') primaryActionButton.textContent = '连接中…'
  else if (state.state === 'stopping') primaryActionButton.textContent = '停止中…'
  else primaryActionButton.textContent = '连接并打开'
  stopButton.disabled = state.state !== 'connected'
  editButton.disabled = busy
}

function render() {
  if (selectedEndpointId === null || !endpoints.some((endpoint) => endpoint.id === selectedEndpointId)) {
    selectedEndpointId = endpoints[0]?.id ?? null
  }
  renderEndpointList()
  renderEndpointDetail()
}

async function refresh() {
  const snapshot = await window.dshTunnel.listEndpoints()
  endpoints = snapshot.endpoints
  tunnelStates.clear()
  for (const state of snapshot.tunnels) tunnelStates.set(state.endpointId, state)
  render()
}

async function connectAndOpen(id) {
  clearNotice()
  try {
    const state = await window.dshTunnel.startTunnel(id)
    tunnelStates.set(id, state)
    render()
    await window.dshTunnel.openEndpoint(id)
  } catch (error) {
    showNotice(error.message)
  }
}

async function openEndpoint(id) {
  clearNotice()
  try {
    await window.dshTunnel.openEndpoint(id)
  } catch (error) {
    showNotice(error.message)
  }
}

async function stopTunnel(id) {
  clearNotice()
  try {
    const state = await window.dshTunnel.stopTunnel(id)
    if (state) tunnelStates.set(id, state)
    render()
  } catch (error) {
    showNotice(error.message)
  }
}

function editEndpoint(endpoint) {
  fields.id.value = endpoint?.id ?? ''
  fields.name.value = endpoint?.name ?? ''
  fields.sshHost.value = endpoint?.sshHost ?? ''
  fields.sshUser.value = endpoint?.sshUser ?? ''
  fields.sshPort.value = endpoint?.sshPort ?? ''
  fields.remotePort.value = endpoint?.remotePort ?? 3080
  fields.localPort.value = endpoint?.localPort ?? nextLocalPort()
  deleteButton.classList.toggle('hidden', endpoint === null)
  document.querySelector('#dialog-title').textContent = endpoint ? '编辑 DSH 主机' : '添加 DSH 主机'
  endpointDialog.showModal()
  fields.name.focus()
}

function nextLocalPort() {
  const used = new Set(endpoints.map((endpoint) => endpoint.localPort))
  let candidate = 13080
  while (used.has(candidate)) candidate += 1
  return candidate
}

async function deleteEndpoint(endpoint) {
  if (!window.confirm(`移除“${endpoint.name}”？这不会删除远端 DSH。`)) return
  clearNotice()
  try {
    await window.dshTunnel.deleteEndpoint(endpoint.id)
    endpointDialog.close()
    if (selectedEndpointId === endpoint.id) selectedEndpointId = null
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
}

function openSettings() {
  settingsCommitted = false
  const selected = settingsForm.querySelector(`input[name="theme"][value="${settings.theme}"]`)
  if (selected) selected.checked = true
  applyTheme(settings.theme)
  settingsDialog.showModal()
}

function cancelSettings() {
  settingsCommitted = false
  settingsDialog.close()
}

for (const id of ['add-endpoint', 'empty-add-endpoint', 'detail-add-endpoint']) {
  document.querySelector(`#${id}`).addEventListener('click', () => editEndpoint(null))
}
document.querySelector('#open-settings').addEventListener('click', openSettings)
document.querySelector('#close-dialog').addEventListener('click', () => endpointDialog.close())
document.querySelector('#cancel-dialog').addEventListener('click', () => endpointDialog.close())
document.querySelector('#close-settings').addEventListener('click', cancelSettings)
document.querySelector('#cancel-settings').addEventListener('click', cancelSettings)

editButton.addEventListener('click', () => {
  const endpoint = selectedEndpoint()
  if (endpoint) editEndpoint(endpoint)
})
stopButton.addEventListener('click', () => {
  const endpoint = selectedEndpoint()
  if (endpoint) stopTunnel(endpoint.id)
})
primaryActionButton.addEventListener('click', () => {
  const endpoint = selectedEndpoint()
  if (!endpoint) return
  if (stateFor(endpoint.id).state === 'connected') openEndpoint(endpoint.id)
  else connectAndOpen(endpoint.id)
})
deleteButton.addEventListener('click', () => {
  const endpoint = endpoints.find((entry) => entry.id === fields.id.value)
  if (endpoint) deleteEndpoint(endpoint)
})

endpointForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  clearNotice()
  try {
    const saved = await window.dshTunnel.saveEndpoint({
      id: fields.id.value,
      name: fields.name.value,
      sshHost: fields.sshHost.value,
      sshUser: fields.sshUser.value,
      sshPort: fields.sshPort.value,
      remotePort: fields.remotePort.value,
      localPort: fields.localPort.value,
    })
    selectedEndpointId = saved.id
    endpointDialog.close()
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
})

settingsForm.addEventListener('change', (event) => {
  if (event.target instanceof HTMLInputElement && event.target.name === 'theme') {
    applyTheme(event.target.value)
  }
})
settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  const selected = settingsForm.querySelector('input[name="theme"]:checked')
  if (!selected) return
  try {
    settings = await window.dshTunnel.saveSettings({ theme: selected.value })
    settingsCommitted = true
    applyTheme(settings.theme)
    settingsDialog.close()
    showNotice(`已切换为“${themeLabels[settings.theme]}”`, 'success')
  } catch (error) {
    applyTheme(settings.theme)
    showNotice(error.message)
  }
})
settingsDialog.addEventListener('close', () => {
  if (!settingsCommitted) applyTheme(settings.theme)
  settingsCommitted = false
})

window.dshTunnel.onTunnelState((state) => {
  tunnelStates.set(state.endpointId, state)
  render()
})

async function initialize() {
  try {
    const loadedSettings = await window.dshTunnel.getSettings()
    if (loadedSettings && supportedThemes.has(loadedSettings.theme)) settings = loadedSettings
    applyTheme(settings.theme)
  } catch (error) {
    showNotice(`无法读取界面设置：${error.message}`)
  }

  try {
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
}

initialize()
