const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

app.commandLine.appendSwitch('force-device-scale-factor', '1')

const projectRoot = path.resolve(__dirname, '..')
const iconSource = fs.readFileSync(path.join(projectRoot, 'resources', 'app-icon.svg'), 'utf8')
const whalePath = iconSource.match(/<path d="([^"]+)"\/>/)?.[1]
if (!whalePath) throw new Error('Whale path not found in app-icon.svg')

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    show: false,
    width: 36,
    height: 32,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: '#00000000',
  })
  const markup = `<!doctype html>
    <html><head><style>
      html, body { width: 36px; height: 32px; margin: 0; overflow: hidden; background: transparent; }
      svg { display: block; width: 36px; height: 32px; }
    </style></head><body>
      <svg viewBox="0 66 512 380" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">
        <path fill="#000000" d="${whalePath}"/>
      </svg>
    </body></html>`
  await window.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(markup)}`)
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 36, height: 32 })
  fs.writeFileSync(path.join(projectRoot, 'resources', 'trayTemplate@2x.png'), image.resize({ width: 36, height: 32 }).toPNG())
  fs.writeFileSync(path.join(projectRoot, 'resources', 'trayTemplate.png'), image.resize({ width: 18, height: 16 }).toPNG())
  window.destroy()
  app.quit()
}).catch((error) => {
  console.error(error)
  app.exit(1)
})
