const test = require('node:test')
const assert = require('node:assert/strict')

const { createSerialExecutor } = require('../src/core/serial-executor.cjs')

test('serial executor does not start the next local DSH operation early', async () => {
  const runSerially = createSerialExecutor()
  const events = []
  let releaseFirst
  const first = runSerially(async () => {
    events.push('first:start')
    await new Promise((resolve) => { releaseFirst = resolve })
    events.push('first:end')
  })
  const second = runSerially(async () => {
    events.push('second:start')
  })

  await Promise.resolve()
  assert.deepEqual(events, ['first:start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
})

test('a failed operation does not poison later local DSH operations', async () => {
  const runSerially = createSerialExecutor()
  await assert.rejects(() => runSerially(async () => { throw new Error('expected') }), /expected/)
  await assert.doesNotReject(() => runSerially(async () => 'ok'))
})
