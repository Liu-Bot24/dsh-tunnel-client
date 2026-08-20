const listElement = document.querySelector('#endpoint-list')
const emptyElement = document.querySelector('#empty-state')
const noticeElement = document.querySelector('#notice')
const dialog = document.querySelector('#endpoint-dialog')
const form = document.querySelector('#endpoint-form')
const fields = {
  id: document.querySelector('#endpoint-id'),
  name: document.querySelector('#endpoint-name'),
  sshHost: document.querySelector('#ssh-host'),
  sshUser: document.querySelector('#ssh-user'),
  sshPort: document.querySelector('#ssh-port'),
  remotePort: document.querySelector('#remote-port'),
  localPort: document.querySelector('#local-port'),
}

let endpoints = []
const tunnelStates = new Map()

function showNotice(message, kind = 'error') {
  noticeElement.textContent = message
  noticeElement.dataset.kind = kind
  noticeElement.classList.remove('hidden')
}

function clearNotice() {
  noticeElement.classList.add('hidden')
  noticeElement.textContent = ''
}

function button(label, className, handler, disabled = false) {
  const element = document.createElement('button')
  element.type = 'button'
  element.className = className
  element.textContent = label
  element.disabled = disabled
  element.addEventListener('click', handler)
  return element
}

function statusLabel(state) {
  if (state === 'connected') return '已连接'
  if (state === 'starting') return '连接中'
  if (state === 'stopping') return '停止中'
  if (state === 'error') return '连接失败'
  return '未连接'
}

function render() {
  listElement.replaceChildren()
  emptyElement.classList.toggle('hidden', endpoints.length !== 0)
  for (const endpoint of endpoints) {
    const state = tunnelStates.get(endpoint.id) ?? { state: 'stopped', error: null }
    const card = document.createElement('article')
    card.className = 'endpoint-card'

    const identity = document.createElement('div')
    identity.className = 'endpoint-identity'
    const title = document.createElement('h2')
    title.textContent = endpoint.name
    const destination = document.createElement('p')
    const user = endpoint.sshUser ? `${endpoint.sshUser}@` : ''
    const sshPort = endpoint.sshPort ? `:${endpoint.sshPort}` : ''
    destination.textContent = `${user}${endpoint.sshHost}${sshPort}  →  127.0.0.1:${endpoint.localPort}`
    identity.append(title, destination)

    const status = document.createElement('div')
    status.className = `status ${state.state}`
    const dot = document.createElement('span')
    dot.className = 'status-dot'
    const statusText = document.createElement('span')
    statusText.textContent = statusLabel(state.state)
    status.append(dot, statusText)

    const actions = document.createElement('div')
    actions.className = 'endpoint-actions'
    const busy = state.state === 'starting' || state.state === 'stopping'
    actions.append(
      button('连接并打开', 'button primary', () => connectAndOpen(endpoint.id), busy),
      button('停止', 'button secondary', () => stopTunnel(endpoint.id), state.state !== 'connected'),
      button('编辑', 'button ghost', () => editEndpoint(endpoint), busy),
      button('移除', 'button danger', () => deleteEndpoint(endpoint), busy),
    )

    card.append(identity, status, actions)
    if (state.error) {
      const error = document.createElement('p')
      error.className = 'endpoint-error'
      error.textContent = state.error
      card.append(error)
    }
    listElement.append(card)
  }
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
  document.querySelector('#dialog-title').textContent = endpoint ? '编辑 DSH 主机' : '添加 DSH 主机'
  dialog.showModal()
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
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
}

document.querySelector('#add-endpoint').addEventListener('click', () => editEndpoint(null))
document.querySelector('#close-dialog').addEventListener('click', () => dialog.close())
document.querySelector('#cancel-dialog').addEventListener('click', () => dialog.close())

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  clearNotice()
  try {
    await window.dshTunnel.saveEndpoint({
      id: fields.id.value,
      name: fields.name.value,
      sshHost: fields.sshHost.value,
      sshUser: fields.sshUser.value,
      sshPort: fields.sshPort.value,
      remotePort: fields.remotePort.value,
      localPort: fields.localPort.value,
    })
    dialog.close()
    await refresh()
  } catch (error) {
    showNotice(error.message)
  }
})

window.dshTunnel.onTunnelState((state) => {
  tunnelStates.set(state.endpointId, state)
  render()
})

refresh().catch((error) => showNotice(error.message))
