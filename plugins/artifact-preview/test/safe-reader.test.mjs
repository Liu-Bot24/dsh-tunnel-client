import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_ARTIFACT_BYTES, readPreviewArtifact } from '../src/safe-reader.mjs'

async function withRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-artifact-read-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('reads one regular UTF-8 preview file inside the session root', async () => {
  await withRoot(async root => {
    await mkdir(path.join(root, 'out'))
    await writeFile(path.join(root, 'out', 'demo.html'), '<h1>ok</h1>')
    const artifact = await readPreviewArtifact(root, 'out/demo.html')
    assert.equal(artifact.name, 'demo.html')
    assert.equal(artifact.content, '<h1>ok</h1>')
    assert.equal(artifact.extension, '.html')
  })
})

test('rejects traversal outside the session creation directory', async () => {
  await withRoot(async root => {
    const outside = path.join(path.dirname(root), 'outside.html')
    await assert.rejects(
      () => readPreviewArtifact(root, outside),
      error => error.code === 'outside-session-root',
    )
  })
})

test('rejects symbolic links', async t => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'real.html'), '<p>real</p>')
    try {
      await symlink(path.join(root, 'real.html'), path.join(root, 'alias.html'))
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.skip('当前 Windows 用户没有创建符号链接的权限')
        return
      }
      throw error
    }
    await assert.rejects(() => readPreviewArtifact(root, 'alias.html'), error => error.code === 'linked-path')
  })
})

test('rejects hard-linked files', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'real.html'), '<p>real</p>')
    await link(path.join(root, 'real.html'), path.join(root, 'hard.html'))
    await assert.rejects(() => readPreviewArtifact(root, 'hard.html'), error => error.code === 'linked-file')
  })
})

test('rejects invalid UTF-8 and files above the size limit', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'invalid.svg'), Buffer.from([0xc3, 0x28]))
    await assert.rejects(() => readPreviewArtifact(root, 'invalid.svg'), error => error.code === 'invalid-utf8')

    await writeFile(path.join(root, 'large.html'), Buffer.alloc(MAX_ARTIFACT_BYTES + 1))
    await assert.rejects(() => readPreviewArtifact(root, 'large.html'), error => error.code === 'file-too-large')
  })
})
