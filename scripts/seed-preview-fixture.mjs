// Add a synthetic native-v4 delivery to the isolated Trace integration fixture.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync } from 'node:zlib'

const [homeArg, workspaceArg, packageArg] = process.argv.slice(2)
if (!homeArg || !workspaceArg || !packageArg) throw new Error('Usage: node scripts/seed-preview-fixture.mjs <isolated DSH_HOME> <workspace> <official DSH package.json>')
const home = await fs.realpath(homeArg), workspace = await fs.realpath(workspaceArg)
if (home === path.resolve(os.homedir(), '.dsh')) throw new Error('Refusing the real DSH_HOME.')
const storagePath = path.join(home, 'storages', 'workspace.json')
const storage = JSON.parse(await fs.readFile(storagePath, 'utf8'))
const project = storage.tables?.workspaces?.['ws-standard-demo']
if (!project || await fs.realpath(project.path) !== workspace) throw new Error('Run the isolated Trace seed first.')
const id = 'session-preview-demo-0003'
if (project.sessionIds.includes(id)) throw new Error('Preview fixture already exists.')
const sourceDirectories = await fs.readdir(path.join(home, 'sessions'))
if (sourceDirectories.length !== 1) throw new Error('Expected exactly one synthetic project.')
const directory = path.join(home, 'sessions', sourceDirectories[0], id)
await fs.mkdir(directory)
const images = {
  png: 'iVBORw0KGgoAAAANSUhEUgAAAFAAAAA8CAIAAAB+RarbAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAqUlEQVRoge3XURFEMQhDUcRV3NXyVK6J7fDRM4MASCAJc76eqlnvwMBhOCudG45oRaXZ0tk2ScEjSSvRMlk6z0O+pW/fMNhSNyCYdcgx3FUIZh1yDIfhrHRuOKIVlWZL54Ga9Q4MHIaz0rnhiFZUmi2dbZMUPJK0Ei2TpfM85Fv69g2DLXUDglmHHMNdhWDWIcdwGM5K54YjWlFptnQeqFnvwMBhuD9C8APrNGYWDKLsbQAAAABJRU5ErkJggg==',
  avif: 'AAAAHGZ0eXBhdmlmAAAAAG1pZjFhdmlmbWlhZgAAANZtZXRhAAAAAAAAACFoZGxyAAAAAAAAAABwaWN0AAAAAAAAAAAAAAAAAAAAACJpbG9jAAAAAERAAAEAAQAAAAAA+gABAAAAAAAAACMAAAAjaWluZgAAAAAAAQAAABVpbmZlAgAAAAABAABhdjAxAAAAAA5waXRtAAAAAAABAAAAVmlwcnAAAAA4aXBjbwAAAAxhdjFDgSACAAAAABRpc3BlAAAAAAAAAFAAAAA8AAAAEHBpeGkAAAAAAwgICAAAABZpcG1hAAAAAAAAAAEAAQOBAgMAAAArbWRhdBIACgk4GWf20gIaDSAyFBShMYJgABoAApfK2DhDHvkxTmBW',
}
for (const [extension, image] of Object.entries(images)) await fs.writeFile(path.join(workspace, `image.${extension}`), Buffer.from(image, 'base64'), { flag: 'wx' })
await fs.writeFile(path.join(workspace, 'demo.html'), '<!doctype html><html><body><h1>HTML preview passed</h1></body></html>', { flag: 'wx' })
await fs.writeFile(path.join(workspace, 'clock.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="#268"/><text x="20" y="80" fill="white">SVG preview passed</text></svg>', { flag: 'wx' })
const now = Date.now()
const header = { version: 4, id, createdAt: now, cwd: workspace, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'system/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { role: 'system', id: 'preview-system', source: { kind: 'system-prompt' }, content: [] } } },
  { type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: 'preview-user', source: { kind: 'user' }, content: [{ type: 'text', text: '预览这些测试文件。' }] } },
  { type: 'deliverables/presented', data: { turn: 1, callId: 'preview-present', files: ['demo.html', 'clock.svg', 'image.png', 'image.avif'].map(name => ({ path: path.join(workspace, name) })) } },
  { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, stream: [], message: {
    role: 'assistant', id: 'preview-assistant', source: { kind: 'model', provider: 'trace-insight-fixture', model: 'fixture-small' },
    content: [{ type: 'text', text: '文件已就绪：`demo.html`、`clock.svg`、`image.png`、`image.avif`。' }],
  } } },
  { type: 'step/end', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map((event, seq) => ({ ...event, seq, time: now + seq }))
const requireDsh = createRequire(path.resolve(packageArg))
const load = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const { releasedV4SessionFormatCodec: codec } = await load('@deepseek-ai/dsh-session-format-v3-to-v4')
const { sessionFormatCatalog } = await load('@deepseek-ai/dsh-session-format-catalog')
const rows = [codec.encodeHeader(header, 0), ...events.map(event => codec.encodeEvent(event))]
const restore = sessionFormatCatalog.createRestore(rows[0], { recovery: 'strict', validation: 'current' })
rows.slice(1).forEach(row => restore.decodeRow(row))
restore.finish()
// Persistence indexes the first frame as the header, independently of the body.
await fs.writeFile(path.join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(rows.map(row => zstdCompressSync(Buffer.from(JSON.stringify(row) + '\n')))), { flag: 'wx' })
project.sessionIds.unshift(id)
await fs.writeFile(storagePath, JSON.stringify(storage, null, 2) + '\n')
console.log(JSON.stringify({ ok: true, sessionId: id, format: 4, files: 4 }))
