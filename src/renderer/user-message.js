(function exposeUserMessage(globalScope) {
  const safeMessages = [
    /^请填写(?:显示名称|SSH 地址)$/,
    /^(?:显示名称|SSH 地址|SSH 用户)太长$/,
    /^SSH 地址格式不正确$/,
    /^SSH 用户格式不正确$/,
    /^(?:SSH 端口|DSH 端口|本地端口)必须是 1–65535 之间的整数$/,
    /^本地端口 \d+ 已(?:被其他程序|被)?占用，请换一个端口$/,
    /^本地端口 \d+ 已被其他程序占用$/,
    /^本地端口 \d+ 已分配给其他主机$/,
    /^请先停止本机 DSH，再修改启动端口$/,
    /^请先断开连接，再修改连接设置$/,
    /^请先连接，再打开 DSH$/,
    /^本机 DSH 尚未启动$/,
    /^本机未安装 DSH$/,
    /^本机 DSH 正在切换状态，请稍后再试$/,
    /^无法停止：DSH 由其他程序启动$/,
    /^没有可用的本地端口$/,
    /^DSH (?:启动失败|启动超时|停止失败|没有响应|已停止)$/,
    /^无法启动 SSH$/,
    /^SSH (?:认证失败|连接被拒绝|主机密钥未确认|主机不可达|连接已中断|连接已结束|断开失败)$/,
    /^找不到 SSH 主机$/,
    /^主机配置当前为只读，请先修复配置文件$/,
  ]

  function userMessage(error, fallback = '操作失败，请重试') {
    const message = typeof error?.message === 'string' ? error.message.trim() : ''
    const wrapped = message.match(/^(?:Error: )?Error invoking remote method '[^']+': (?:Error: )?([\s\S]+)$/)
    const candidate = (wrapped?.[1] ?? message).trim()
    return safeMessages.some((pattern) => pattern.test(candidate)) ? candidate : fallback
  }

  const api = Object.freeze({ userMessage })
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else globalScope.dshMessages = api
})(globalThis)
