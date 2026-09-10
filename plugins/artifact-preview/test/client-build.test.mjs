import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('client injection follows version-specific transitive dependencies across rc.2 and rc.1', async () => {
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.deepEqual(manifest.dsh.client.inject, [
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-deliverables',
  ])
  assert.equal(manifest.dshCompatibility.version, '0.1.2-rc.1 || 0.1.5-rc.1 || 0.1.5-rc.2')
})

test('generated client is marker-gated and shadows only the produced-files chain', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /dsh_tunnel_preview/u)
  assert.match(source, /url\.hash\.slice\(1\)/u)
  assert.match(source, /priority: -100/u)
  assert.match(source, /ProducedFiles/u)
  assert.match(source, /isLoopback: false/u)
})

test('generated client keeps native files on the original opener and preview failures closed', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /nativeOpen\(producedPath\)/u)
  assert.match(source, /if \(policy\.disposition === 'reject'\)[\s\S]+?openPreviewPage/u)
  assert.match(source, /openPreviewPage\(\{ kind: 'preview', sessionId, producedPath \}\)/u)
  assert.match(source, /window\.open\(previewUrl\(request\), '_blank', 'noopener,noreferrer'\)/u)
  assert.match(source, /dsh_artifact_preview/u)
  assert.match(source, /sandbox', 'allow-scripts'/u)
  assert.match(source, /connect-src 'none'/u)
  assert.match(source, /img-src data: blob:/u)
  assert.match(source, /artifact\.encoding === 'base64'/u)
  assert.match(source, /artifact\.mediaType/u)
  assert.match(source, /chatFileMentions/u)
  assert.match(source, /artifact-preview: prose file mentions/u)
})
