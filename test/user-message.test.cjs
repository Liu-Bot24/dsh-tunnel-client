const test = require('node:test')
const assert = require('node:assert/strict')
const { userMessage } = require('../src/renderer/user-message.js')

test('removes the Electron IPC prefix from a safe user-facing message', () => {
  const error = new Error("Error invoking remote method 'tunnels:start': 本地端口 13080 已被占用，请换一个端口")
  assert.equal(userMessage(error), '本地端口 13080 已被占用，请换一个端口')
})

test('does not expose an unknown internal error', () => {
  const error = new Error('unexpected internal detail')
  assert.equal(userMessage(error, '连接失败，请检查设置'), '连接失败，请检查设置')
})

test('does not expose an internal error merely because it is written in Chinese', () => {
  const error = new Error("Error invoking remote method 'internal': 请求来源不受信任")
  assert.equal(userMessage(error, '操作失败'), '操作失败')
})
