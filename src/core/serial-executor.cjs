function createSerialExecutor() {
  let tail = Promise.resolve()
  return function runSerially(task) {
    if (typeof task !== 'function') return Promise.reject(new TypeError('串行任务必须是函数'))
    const result = tail.then(task, task)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
}

module.exports = { createSerialExecutor }
