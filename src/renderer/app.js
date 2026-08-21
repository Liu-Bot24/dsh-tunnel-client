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
const { userMessage } = window.dshMessages

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
const saveButton = document.querySelector('#save-endpoint')
const sshFieldsElement = document.querySelector('#ssh-fields')
const portsRowElement = document.querySelector('#ports-row')
const localPortFieldElement = document.querySelector('#local-port-field')
const dshPortLabelElement = document.querySelector('#dsh-port-label')
const dshPortNoteElement = document.querySelector('#dsh-port-note')
const fields = {
  id: document.querySelector('#endpoint-id'),
  mode: document.querySelector('#endpoint-mode'),
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
  method: document.querySelector('#detail-method'),
  targetLabel: document.querySelector('#detail-target-label'),
  ssh: document.querySelector('#detail-ssh'),
  local: document.querySelector('#detail-local'),
  remote: document.querySelector('#detail-remote'),
  routeLocal: document.querySelector('#route-local'),
  routeRemote: document.querySelector('#route-remote'),
  status: document.querySelector('#detail-status'),
  error: document.querySelector('#endpoint-error'),
}
const tunnelDetailElement = document.querySelector('#tunnel-detail')
const routeStripElement = document.querySelector('#route-strip')
const primaryActionButton = document.querySelector('#primary-endpoint-action')
const stopButton = document.querySelector('#stop-tunnel')
const editButton = document.querySelector('#edit-endpoint')

let endpoints = []
let selectedEndpointId = null
let settings = { theme: 'whale-song' }
let settingsCommitted = false
let noticeTimer = null
let localDshState = { state: 'stopped', port: 3080, owned: false, error: null }
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

function localStatusLabel(state) {
  if (state === 'running') return '运行中'
  if (state === 'starting') return '启动中'
  if (state === 'stopping') return '停止中'
  if (state === 'error') return '启动失败'
  return '本机未启动'
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
    const isLocal = endpoint.mode === 'local'
    const state = isLocal ? localDshState : stateFor(endpoint.id)
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
    dot.className = `status-dot ${isLocal && state.state === 'running' ? 'connected' : state.state}`
    const copy = document.createElement('span')
    copy.className = 'endpoint-row-copy'
    const name = document.createElement('span')
    name.className = 'endpoint-row-name'
    name.textContent = endpoint.name
    const meta = document.createElement('span')
    meta.className = 'endpoint-row-meta'
    meta.textContent = isLocal
      ? `127.0.0.1:${endpoint.remotePort} · ${localStatusLabel(state.state)}`
      : `${endpoint.sshHost} · ${statusLabel(state.state)}`
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

  const isLocal = endpoint.mode === 'local'
  const state = isLocal ? localDshState : stateFor(endpoint.id)
  const busy = state.state === 'starting' || state.state === 'stopping'
  detailFields.name.textContent = endpoint.name
  detailFields.alias.textContent = isLocal ? '本机 · 直接访问' : `${endpoint.sshHost} · SSH`
  detailFields.method.textContent = isLocal ? '本机直连' : 'SSH 隧道'
  detailFields.targetLabel.textContent = isLocal ? '地址' : '目标'
  detailFields.ssh.textContent = isLocal ? `127.0.0.1:${endpoint.remotePort}` : sshTarget(endpoint)
  if (!isLocal) {
    detailFields.local.textContent = `127.0.0.1:${endpoint.localPort}`
    detailFields.remote.textContent = `127.0.0.1:${endpoint.remotePort}`
    detailFields.routeLocal.textContent = `127.0.0.1:${endpoint.localPort}`
    detailFields.routeRemote.textContent = `127.0.0.1:${endpoint.remotePort}`
  }
  tunnelDetailElement.classList.toggle('hidden', isLocal)
  routeStripElement.classList.toggle('hidden', isLocal)
  const statusClass = isLocal && state.state === 'running' ? 'connected' : state.state
  detailFields.status.className = `status ${statusClass}`
  detailFields.status.querySelector('span').textContent = isLocal ? localStatusLabel(state.state) : statusLabel(state.state)
  const stateError = state.error
    ? userMessage({ message: state.error }, isLocal ? 'DSH 启动失败' : '连接失败')
    : ''
  detailFields.error.textContent = stateError
  detailFields.error.classList.toggle('hidden', !stateError)

  primaryActionButton.disabled = busy
  if (isLocal && state.state === 'starting') primaryActionButton.textContent = '正在启动…'
  else if (isLocal && state.state === 'stopping') primaryActionButton.textContent = '正在停止…'
  else if (isLocal && state.state === 'running') primaryActionButton.textContent = '打开 WebUI'
  else if (isLocal) primaryActionButton.textContent = '启动并打开'
  else if (state.state === 'connected') primaryActionButton.textContent = '打开 DSH'
  else if (state.state === 'starting') primaryActionButton.textContent = '连接中…'
  else if (state.state === 'stopping') primaryActionButton.textContent = '停止中…'
  else primaryActionButton.textContent = '连接并打开'
  stopButton.classList.remove('hidden')
  stopButton.textContent = isLocal ? '停止' : '断开'
  stopButton.disabled = isLocal ? state.state !== 'running' || !state.owned : state.state !== 'connected'
  editButton.classList.remove('hidden')
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
  localDshState = snapshot.localDsh ?? localDshState
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
    showNotice(userMessage(error, '连接失败'))
  }
}

async function openEndpoint(id) {
  clearNotice()
  try {
    await window.dshTunnel.openEndpoint(id)
  } catch (error) {
    const endpoint = endpoints.find((entry) => entry.id === id)
    const fallback = endpoint?.mode === 'local'
      ? '本机 DSH 未启动'
      : 'DSH 无法打开'
    showNotice(userMessage(error, fallback))
  }
}

async function stopTunnel(id) {
  clearNotice()
  try {
    const state = await window.dshTunnel.stopTunnel(id)
    if (state) tunnelStates.set(id, state)
    render()
  } catch (error) {
    showNotice(userMessage(error, '断开失败'))
  }
}

function editEndpoint(endpoint) {
  const isLocal = endpoint?.mode === 'local'
  fields.id.value = endpoint?.id ?? ''
  fields.mode.value = isLocal ? 'local' : 'ssh'
  fields.name.value = endpoint?.name ?? ''
  fields.sshHost.value = endpoint?.sshHost ?? ''
  fields.sshUser.value = endpoint?.sshUser ?? ''
  fields.sshPort.value = endpoint?.sshPort ?? ''
  fields.remotePort.value = endpoint?.remotePort ?? 3080
  fields.localPort.value = endpoint?.localPort ?? nextLocalPort()
  sshFieldsElement.classList.toggle('hidden', isLocal)
  localPortFieldElement.classList.toggle('hidden', isLocal)
  portsRowElement.classList.toggle('single-field', isLocal)
  for (const field of [fields.sshHost, fields.sshUser, fields.sshPort, fields.localPort]) field.disabled = isLocal
  dshPortLabelElement.textContent = 'DSH 端口'
  dshPortNoteElement.textContent = isLocal
    ? '本机 DSH 的监听端口。'
    : 'SSH 目标侧可访问的 DSH 端口。'
  deleteButton.classList.toggle('hidden', endpoint === null || isLocal)
  document.querySelector('#dialog-title').textContent = isLocal ? '编辑本机 DSH' : (endpoint ? '编辑主机' : '添加主机')
  saveButton.textContent = '保存'
  endpointDialog.showModal()
  fields.name.focus()
}

function nextLocalPort() {
  const used = new Set(endpoints.filter((endpoint) => endpoint.mode === 'ssh').map((endpoint) => endpoint.localPort))
  let candidate = 13080
  while (used.has(candidate)) candidate += 1
  return candidate
}

async function deleteEndpoint(endpoint) {
  if (!window.confirm(`删除“${endpoint.name}”？`)) return
  clearNotice()
  try {
    await window.dshTunnel.deleteEndpoint(endpoint.id)
    endpointDialog.close()
    if (selectedEndpointId === endpoint.id) selectedEndpointId = null
    await refresh()
  } catch (error) {
    showNotice(userMessage(error, '删除失败'))
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

async function startLocalDsh() {
  clearNotice()
  try {
    const result = await window.dshTunnel.startLocalDsh()
    if (!result.cancelled) {
      localDshState = result.state
      await refresh()
      await openLocalDsh()
    }
  } catch (error) {
    showNotice(userMessage(error, '启动失败'))
    await refresh().catch(() => undefined)
  }
}

async function stopLocalDsh() {
  clearNotice()
  try {
    localDshState = await window.dshTunnel.stopLocalDsh()
    render()
  } catch (error) {
    showNotice(userMessage(error, '停止失败'))
    await refresh().catch(() => undefined)
  }
}

async function openLocalDsh() {
  clearNotice()
  try {
    await window.dshTunnel.openLocalDsh()
  } catch (error) {
    showNotice(userMessage(error, 'WebUI 无法打开'))
  }
}

document.querySelector('#add-endpoint').addEventListener('click', () => editEndpoint(null))

for (const id of ['empty-add-endpoint', 'detail-add-endpoint']) {
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
  if (!endpoint) return
  if (endpoint.mode === 'local') stopLocalDsh()
  else stopTunnel(endpoint.id)
})
primaryActionButton.addEventListener('click', () => {
  const endpoint = selectedEndpoint()
  if (!endpoint) return
  if (endpoint.mode === 'local' && localDshState.state !== 'running') startLocalDsh()
  else if (endpoint.mode === 'local') openLocalDsh()
  else if (stateFor(endpoint.id).state === 'connected') openEndpoint(endpoint.id)
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
    const isLocal = fields.mode.value === 'local'
    const saved = isLocal
      ? await window.dshTunnel.saveLocalDsh({ name: fields.name.value, remotePort: fields.remotePort.value })
      : await window.dshTunnel.saveEndpoint({
        id: fields.id.value,
        mode: 'ssh',
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
    showNotice(userMessage(error, '保存失败'))
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
    showNotice(userMessage(error, '主题保存失败'))
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

window.dshTunnel.onLocalDshState((state) => {
  localDshState = state
  render()
})

async function initialize() {
  try {
    const loadedSettings = await window.dshTunnel.getSettings()
    if (loadedSettings && supportedThemes.has(loadedSettings.theme)) settings = loadedSettings
    applyTheme(settings.theme)
  } catch (error) {
    showNotice(userMessage(error, '设置读取失败'))
  }

  try {
    await refresh()
  } catch (error) {
    showNotice(userMessage(error, '主机列表读取失败'))
  }
}

initialize()
