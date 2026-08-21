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

test('preserves safe messages that begin with SSH instead of truncating them', () => {
  assert.equal(userMessage(new Error('SSH 认证失败')), 'SSH 认证失败')
  assert.equal(userMessage(new Error('SSH 用户太长')), 'SSH 用户太长')
  assert.equal(userMessage(new Error('无法解析 SSH 主机配置')), '无法解析 SSH 主机配置')
  assert.equal(userMessage(new Error('读取 SSH 主机配置超时')), '读取 SSH 主机配置超时')
})

test('covers actual local DSH and port errors with and without an IPC wrapper', () => {
  const messages = [
    '本地端口 3080 已被其他程序占用',
    'DSH 停止失败',
    '请先断开连接，再修改连接设置',
  ]
  for (const message of messages) {
    assert.equal(userMessage(new Error(message)), message)
    assert.equal(
      userMessage(new Error(`Error invoking remote method 'test': Error: ${message}`)),
      message,
    )
  }
})
