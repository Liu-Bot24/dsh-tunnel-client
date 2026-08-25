import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pluginDirectory = path.join(projectDirectory, 'plugins', 'artifact-preview')
const outputDirectory = path.join(projectDirectory, 'resources', 'plugins')
const pluginPackage = JSON.parse(await fs.readFile(path.join(pluginDirectory, 'package.json'), 'utf8'))
const archiveName = `${pluginPackage.name}-${pluginPackage.version}.tgz`

await fs.mkdir(outputDirectory, { recursive: true })
for (const entry of await fs.readdir(outputDirectory)) {
  if (entry.startsWith(`${pluginPackage.name}-`) && entry.endsWith('.tgz')) {
    await fs.unlink(path.join(outputDirectory, entry))
  }
}

await runNpm(['run', 'build'], pluginDirectory)
await runNpm(['run', 'check'], pluginDirectory)
await runNpm(['test'], pluginDirectory)
const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tunnel-npm-cache-'))
try {
  await runNpm(['pack', '--ignore-scripts', '--pack-destination', outputDirectory], pluginDirectory, {
    ...process.env,
    npm_config_cache: npmCache,
  })
} finally {
  await fs.rm(npmCache, { recursive: true, force: true })
}

const archivePath = path.join(outputDirectory, archiveName)
await fs.access(archivePath)
console.log(`Prepared companion plugin: ${archivePath}`)

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code ?? 'unknown'})`))
    })
  })
}

function runNpm(args, cwd, env = process.env) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args], cwd, env)
  }
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, cwd, env)
}
