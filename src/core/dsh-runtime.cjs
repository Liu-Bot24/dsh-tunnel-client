const fs = require('node:fs')
const path = require('node:path')
const { resolveDshVersion, supportsNoOpen } = require('./local-dsh-manager.cjs')

const NPX_STARTUP_TIMEOUT = 300_000
const DEFAULT_DSH_LAUNCH_COMMAND = 'npx --yes @deepseek-ai/dsh'
const MAX_DSH_LAUNCH_COMMAND_LENGTH = 2_048

function parseLaunchCommand(input) {
  const value = String(input ?? '').trim()
  if (!value) throw new Error('DSH 启动命令不能为空')
  if (value.length > MAX_DSH_LAUNCH_COMMAND_LENGTH) throw new Error('DSH 启动命令过长')
  if (/\r|\n|\0/u.test(value)) throw new Error('DSH 启动命令只能填写一行')

  const args = []
  let current = ''
  let quote = null
  let started = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote !== null) {
      if (character === quote) {
        quote = null
      } else if (quote === '"' && character === '\\' && value[index + 1] === '"') {
        current += '"'
        index += 1
      } else {
        current += character
      }
      started = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      started = true
    } else if (/\s/u.test(character)) {
      if (started) {
        args.push(current)
        current = ''
        started = false
      }
    } else {
      current += character
      started = true
    }
  }
  if (quote !== null) throw new Error('DSH 启动命令的引号没有闭合')
  if (started) args.push(current)
  if (!args.length || !args[0]) throw new Error('DSH 启动命令不能为空')
  return args
}

function normalizeDshLaunchCommand(input = DEFAULT_DSH_LAUNCH_COMMAND) {
  const value = String(input ?? '').trim()
  parseLaunchCommand(value)
  return value
}

function launchEnvironment(platform = process.platform, environment = process.env) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  const currentPath = environment.PATH ?? environment.Path ?? environment.path ?? ''
  const existing = currentPath.split(pathApi.delimiter).filter(Boolean)
  const common = platform === 'darwin'
    ? ['/opt/homebrew/bin', '/usr/local/bin']
    : platform === 'win32'
      ? [
          environment.NVM_SYMLINK,
          environment.ProgramFiles && pathApi.join(environment.ProgramFiles, 'nodejs'),
          environment.APPDATA && pathApi.join(environment.APPDATA, 'npm'),
        ].filter(Boolean)
      : ['/usr/local/bin', '/usr/bin']
  const entries = [...common, ...existing]
    .filter((entry, index, all) => all.indexOf(entry) === index)
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => key.toLowerCase() !== 'path')),
    PATH: entries.join(pathApi.delimiter),
  }
}

function resolveCommandExecutable(command, {
  platform = process.platform,
  environment = process.env,
  existsSync = fs.existsSync,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (pathApi.isAbsolute(command)) return command
  if (command.includes('/') || command.includes('\\')) return pathApi.resolve(command)
  const directories = (environment.PATH ?? '').split(pathApi.delimiter).filter(Boolean)
  const extensions = platform === 'win32'
    ? (pathApi.extname(command) ? [''] : ['.cmd', '.exe', '.bat', ''])
    : ['']
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathApi.join(directory, `${command}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return command
}

function inferNoOpenSupport(commandParts) {
  const rawSpec = commandParts.find(part => (
    /^@deepseek-ai\/dsh@/u.test(part)
    || /^--package=@deepseek-ai\/dsh@/u.test(part)
  ))
  const packageSpec = rawSpec?.replace(/^--package=/u, '')
  if (/^@deepseek-ai\/dsh@(?:latest|next)$/u.test(packageSpec ?? '')) return true
  const match = packageSpec?.match(/^@deepseek-ai\/dsh@(\d+\.\d+\.\d+(?:-rc\.\d+)?)$/u)
  return match ? supportsNoOpen(match[1]) : null
}

function resolveDshRuntime({
  bundledExecutable,
  launchCommand = DEFAULT_DSH_LAUNCH_COMMAND,
  environment = process.env,
  platform = process.platform,
  existsSync = fs.existsSync,
  versionResolver = resolveDshVersion,
} = {}) {
  if (!bundledExecutable) throw new Error('DSH 启动器不可用')
  const normalizedCommand = normalizeDshLaunchCommand(launchCommand)
  const commandEnvironment = launchEnvironment(platform, environment)
  const parsed = parseLaunchCommand(normalizedCommand)
  const usesDefault = normalizedCommand === DEFAULT_DSH_LAUNCH_COMMAND
  const executable = usesDefault
    ? bundledExecutable
    : resolveCommandExecutable(parsed[0], { platform, environment: commandEnvironment, existsSync })
  const commandArgs = usesDefault ? [] : parsed.slice(1)
  const noOpenSupported = usesDefault ? null : inferNoOpenSupport(parsed)
  return Object.freeze({
    launchCommand: normalizedCommand,
    executable,
    commandArgs: Object.freeze(commandArgs),
    environment: Object.freeze(commandEnvironment),
    environmentExecutable: executable,
    version: null,
    noOpenSupported,
    startupTimeout: NPX_STARTUP_TIMEOUT,
    resolveVersion: runtimeExecutable => versionResolver(runtimeExecutable, {
      commandArgs,
      environment: commandEnvironment,
    }),
  })
}

module.exports = {
  DEFAULT_DSH_LAUNCH_COMMAND,
  inferNoOpenSupport,
  launchEnvironment,
  normalizeDshLaunchCommand,
  parseLaunchCommand,
  resolveCommandExecutable,
  resolveDshRuntime,
}
