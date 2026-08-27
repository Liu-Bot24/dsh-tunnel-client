import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { classifyProducedPath } = require('../src/path-policy.cjs')

test('classifies supported preview extensions case-insensitively', () => {
  assert.deepEqual(classifyProducedPath('demo.HTML'), { disposition: 'preview', extension: '.html' })
  assert.deepEqual(classifyProducedPath('nested/diagram.svg'), { disposition: 'preview', extension: '.svg' })
  for (const filename of ['photo.PNG', 'photo.jpg', 'photo.JPEG', 'photo.webp', 'photo.gif', 'photo.avif']) {
    assert.equal(classifyProducedPath(filename).disposition, 'preview', filename)
  }
})

test('keeps clearly non-preview files on the native path', () => {
  assert.deepEqual(classifyProducedPath('notes.txt'), { disposition: 'native' })
  assert.deepEqual(classifyProducedPath('README'), { disposition: 'native' })
  assert.deepEqual(classifyProducedPath('report.html#draft'), { disposition: 'native' })
})

test('rejects ambiguous or dangerous path spellings', () => {
  for (const candidate of ['C:demo.html', '\\\\server\\demo.html', 'file.html:stream', 'demo.html.', 'demo.html ', 'dir/']) {
    assert.equal(classifyProducedPath(candidate).disposition, 'reject', candidate)
  }
})
