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
    /^未找到 npx，请先安装 Node\.js$/,
    /^DSH 下载(?:失败|超时)，请检查网络连接$/,
    /^本机 DSH 正在切换状态，请稍后再试$/,
    /^无法停止：DSH 由其他程序启动$/,
    /^没有可用的本地端口$/,
    /^DSH (?:启动失败|启动超时|停止失败|没有响应|已停止)$/,
    /^无法启动 SSH$/,
    /^SSH (?:认证失败|连接被拒绝|主机密钥未确认|主机不可达|连接已中断|连接已结束|断开失败)$/,
    /^首次配对需要填写 SSH 用户$/,
    /^请输入 SSH 登录密码$/,
    /^SSH 登录密码太长$/,
    /^请确认 SSH 主机指纹$/,
    /^SSH 主机指纹已变化，请重新确认$/,
    /^SSH 用户名或密码不正确$/,
    /^SSH 配对失败$/,
    /^无法读取 SSH 主机密钥$/,
    /^无法解析 SSH 主机配置$/,
    /^读取 SSH 主机配置超时$/,
    /^无法读取 SSH 主机配置$/,
    /^无法读取 SSH 主机信任记录$/,
    /^无法生成客户端 SSH 密钥$/,
    /^系统缺少 OpenSSH 工具$/,
    /^找不到 SSH 主机$/,
    /^主机配置当前为只读，请先修复配置文件$/,
    /^请先停止本机 DSH，再安装配套插件$/,
    /^请先停止本机 DSH，再卸载配套插件$/,
    /^配套插件安装包不可用，请重新安装 DSH Tunnel$/,
    /^无法启动 DSH 插件安装程序$/,
    /^无法启动 DSH 插件卸载程序$/,
    /^DSH 插件(?:存储|目录)不可写$/,
    /^DSH 插件配置不可用$/,
    /^DSH Web 配置初始化失败$/,
    /^配套插件安装(?:失败|超时)$/,
    /^配套插件安装后未能验证$/,
    /^配套插件卸载(?:失败|超时|后未能验证)$/,
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
