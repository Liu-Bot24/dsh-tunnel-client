import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPaths = await packager({
  dir: projectDirectory,
  name: 'DSH Tunnel',
  platform: 'darwin',
  arch: 'arm64',
  appBundleId: 'app.dshtunnel.client',
  icon: path.join(projectDirectory, 'resources', 'app-icon.icns'),
  out: path.join(projectDirectory, 'dist'),
  overwrite: true,
  ignore: [
    /(^|\/)dist($|\/)/,
    /(^|\/)test($|\/)/,
    /(^|\/)scripts($|\/)/,
    /(^|\/)resources($|\/)/,
    /(^|\/)node_modules($|\/)/,
    /(^|\/)DEVELOPMENT_LOG\.md$/,
    /(^|\/)\.gitignore$/,
    /(^|\/)README\.md$/,
  ],
})

const appPath = path.join(outputPaths[0], 'DSH Tunnel.app')
await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', appPath])
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath])
console.log(`Packaged and verified: ${appPath}`)

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectDirectory,
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} failed (${signal ?? code ?? 'unknown'})`))
    })
  })
}
