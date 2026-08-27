import test from 'node:test'
import assert from 'node:assert/strict'
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  MAX_ARTIFACT_BYTES,
  MAX_IMAGE_ARTIFACT_BYTES,
  readPreviewArtifact,
} from '../src/safe-reader.mjs'

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
    assert.equal(artifact.encoding, 'utf8')
    assert.equal(artifact.mediaType, 'text/html')
    assert.equal(artifact.extension, '.html')
  })
})

test('reads browser-native images as verified base64 payloads', async () => {
  const fixtures = [
    ['photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    ['photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]), 'image/jpeg'],
    ['photo.gif', Buffer.from('GIF89a', 'ascii'), 'image/gif'],
    ['photo.webp', Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WEBP', 'ascii')]), 'image/webp'],
    ['photo.avif', Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0, 0x61, 0x76, 0x69, 0x66, 0, 0, 0, 0]), 'image/avif'],
  ]
  await withRoot(async root => {
    for (const [filename, bytes, mediaType] of fixtures) {
      await writeFile(path.join(root, filename), bytes)
      const artifact = await readPreviewArtifact(root, filename)
      assert.equal(artifact.encoding, 'base64', filename)
      assert.equal(artifact.mediaType, mediaType, filename)
      assert.equal(artifact.content, bytes.toString('base64'), filename)
    }
  })
})

test('rejects image extensions whose bytes do not match the declared type', async () => {
  await withRoot(async root => {
    await writeFile(path.join(root, 'fake.png'), '<script>alert(1)</script>')
    await assert.rejects(() => readPreviewArtifact(root, 'fake.png'), error => error.code === 'invalid-image')
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

    await writeFile(path.join(root, 'large.png'), Buffer.alloc(MAX_IMAGE_ARTIFACT_BYTES + 1))
    await assert.rejects(() => readPreviewArtifact(root, 'large.png'), error => error.code === 'file-too-large')
  })
})
