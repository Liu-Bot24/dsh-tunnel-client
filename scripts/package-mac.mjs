import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { packager } from '@electron/packager'

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await fs.readFile(path.join(projectDirectory, 'package.json'), 'utf8'))
const architecture = process.arch === 'arm64' ? 'arm64' : process.arch
const outputDirectory = path.join(projectDirectory, 'dist', 'mac')
const artifactStem = `DSH.Tunnel-${packageJson.version}-macos-${architecture}`
const dmgPath = path.join(outputDirectory, `${artifactStem}.dmg`)
const checksumPath = `${dmgPath}.sha256`

const outputPaths = await packager({
  dir: projectDirectory,
  name: 'DSH Tunnel',
  platform: 'darwin',
  arch: process.arch,
  appBundleId: 'app.dshtunnel.client',
  icon: path.join(projectDirectory, 'resources', 'app-icon.icns'),
  extraResource: [
    path.join(projectDirectory, 'resources', 'trayTemplate.png'),
    path.join(projectDirectory, 'resources', 'trayTemplate@2x.png'),
  ],
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

await fs.mkdir(outputDirectory, { recursive: true })
await fs.rm(dmgPath, { force: true })
await fs.rm(checksumPath, { force: true })

const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tunnel-dmg-'))
const temporaryDmgPath = path.join(temporaryDirectory, `${artifactStem}.tmp.dmg`)
const mountDirectory = '/Volumes/DSH Tunnel'
const verifyDirectory = path.join(temporaryDirectory, 'verify')
let mountedDirectory = null

try {
  await fs.mkdir(verifyDirectory)
  if (await pathExists(mountDirectory)) {
    throw new Error(`A volume is already mounted at ${mountDirectory}`)
  }
  await run('/usr/bin/hdiutil', [
    'create',
    '-volname', 'DSH Tunnel',
    '-size', '512m',
    '-fs', 'HFS+',
    '-type', 'UDIF',
    '-ov',
    temporaryDmgPath,
  ])
  await run('/usr/bin/hdiutil', [
    'attach',
    '-readwrite',
    '-noverify',
    '-noautoopen',
    temporaryDmgPath,
  ])
  if (!(await pathExists(mountDirectory))) throw new Error('Unable to mount writable DMG')
  mountedDirectory = mountDirectory

  await run('/usr/bin/ditto', [appPath, path.join(mountDirectory, 'DSH Tunnel.app')])
  await fs.symlink('/Applications', path.join(mountDirectory, 'Applications'), 'dir')
  const backgroundDirectory = path.join(mountDirectory, '.background')
  await fs.mkdir(backgroundDirectory)
  await run('/usr/bin/swift', [
    path.join(projectDirectory, 'scripts', 'render-dmg-background.swift'),
    path.join(backgroundDirectory, 'background.png'),
  ])
  await run('/usr/bin/chflags', ['hidden', backgroundDirectory])
  await configureDmgWindow()
  await run('/usr/bin/hdiutil', ['detach', mountDirectory])
  mountedDirectory = null

  await run('/usr/bin/hdiutil', [
    'convert',
    temporaryDmgPath,
    '-format', 'UDZO',
    '-imagekey', 'zlib-level=9',
    '-o', dmgPath,
  ])
  await run('/usr/bin/hdiutil', ['verify', dmgPath])
  await run('/usr/bin/hdiutil', [
    'attach',
    '-readonly',
    '-nobrowse',
    '-mountpoint', verifyDirectory,
    dmgPath,
  ])
  mountedDirectory = verifyDirectory
  await run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '--verbose=2',
    path.join(verifyDirectory, 'DSH Tunnel.app'),
  ])
  const applicationsLink = await fs.readlink(path.join(verifyDirectory, 'Applications'))
  if (applicationsLink !== '/Applications') throw new Error('DMG Applications shortcut is invalid')
  await run('/usr/bin/hdiutil', ['detach', verifyDirectory])
  mountedDirectory = null

  const checksum = await sha256(dmgPath)
  await fs.writeFile(checksumPath, `${checksum}  ${path.basename(dmgPath)}\n`, { mode: 0o644 })
} finally {
  if (mountedDirectory !== null) {
    await run('/usr/bin/hdiutil', ['detach', mountedDirectory]).catch(() => undefined)
  }
  await fs.rm(temporaryDirectory, { recursive: true, force: true })
}

console.log(`Packaged and verified app: ${appPath}`)
console.log(`Packaged and verified installer: ${dmgPath}`)
console.log(`Created checksum: ${checksumPath}`)

function configureDmgWindow() {
  const commands = [
    'tell application "Finder"',
    'tell disk "DSH Tunnel"',
    'open',
    'set current view of container window to icon view',
    'set toolbar visible of container window to false',
    'set statusbar visible of container window to false',
    'set the bounds of container window to {120, 120, 740, 480}',
    'set viewOptions to the icon view options of container window',
    'set arrangement of viewOptions to not arranged',
    'set icon size of viewOptions to 96',
    'set background picture of viewOptions to file ".background:background.png"',
    'set position of item "DSH Tunnel.app" of container window to {160, 200}',
    'set position of item "Applications" of container window to {460, 200}',
    'update without registering applications',
    'delay 1',
    'close',
    'end tell',
    'end tell',
  ]
  return run('/usr/bin/osascript', commands.flatMap((command) => ['-e', command]))
}

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filename)
    stream.once('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', () => resolve(hash.digest('hex')))
  })
}

async function pathExists(filename) {
  try {
    await fs.access(filename)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

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
