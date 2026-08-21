const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')
const css = fs.readFileSync(path.join(projectRoot, 'src/renderer/styles.css'), 'utf8')

function themeVariables(theme) {
  const block = css.match(new RegExp(`html\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1]
  assert.ok(block, `missing theme: ${theme}`)
  return Object.fromEntries([...block.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((match) => [match[1], match[2]]))
}

function luminance(hex) {
  const channels = [1, 3, 5]
    .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground, background) {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function blend(foreground, background, alpha) {
  const channel = (hex, index) => Number.parseInt(hex.slice(index, index + 2), 16)
  const result = [1, 3, 5].map((index) => Math.round(channel(foreground, index) * alpha + channel(background, index) * (1 - alpha)))
  return `#${result.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

test('small muted text meets contrast targets on light theme sidebars', () => {
  for (const theme of ['nautical-chart', 'soft-porcelain']) {
    const variables = themeVariables(theme)
    assert.ok(contrast(variables['muted-color'], variables['sidebar-bg']) >= 4.5, `${theme} muted text is too faint`)
  }
})

test('Bauhaus sidebar metadata overrides the former low-contrast gray', () => {
  const variables = themeVariables('bauhaus-signal')
  assert.ok(contrast('#656159', variables['sidebar-bg']) < 1.1, 'negative fixture should reproduce the old failure')
  const corrected = blend('#ffffff', variables['sidebar-bg'], 0.82)
  assert.ok(contrast(corrected, variables['sidebar-bg']) >= 4.5)
  assert.match(css, /bauhaus-signal"] \.endpoint-row:not\(\[aria-selected="true"\]\) \.endpoint-row-meta \{ color: rgba\(255,255,255,\.82\); \}/)
})

test('theme font stacks include explicit Chinese fallbacks', () => {
  assert.match(css, /--app-font:[^;]*"PingFang SC"/)
  assert.match(css, /nautical-chart"] \.detail-heading h1[^\{]*\{ font-family: "New York", "Songti SC", STSong, Georgia, serif;/)
  for (const theme of ['nautical-chart', 'phosphor', 'bauhaus-signal', 'soft-porcelain']) {
    const block = css.match(new RegExp(`html\\[data-theme="${theme}"\\] \\{([\\s\\S]*?)\\n\\}`))?.[1]
    assert.match(block, /--app-font:[^;]*"PingFang SC"/)
  }
})

test('localized READMEs include optimized JPEG screenshots for every theme', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8')
  const readmeEn = fs.readFileSync(path.join(projectRoot, 'README.en.md'), 'utf8')
  const heroPath = 'docs/images/hero.jpg'
  const hero = fs.readFileSync(path.join(projectRoot, heroPath))
  const themes = [
    'whale-song',
    'nautical-chart',
    'phosphor',
    'bauhaus-signal',
    'soft-porcelain',
    'theme-selector',
  ]

  assert.match(readme, /\[English\]\(README\.en\.md\)/)
  assert.match(readmeEn, /\[简体中文\]\(README\.md\)/)
  assert.match(readme, new RegExp(heroPath.replaceAll('.', '\\.')))
  assert.match(readmeEn, new RegExp(heroPath.replaceAll('.', '\\.')))
  assert.deepEqual(hero.subarray(0, 2), Buffer.from([0xff, 0xd8]))
  assert.ok(hero.length < 300 * 1024, 'hero image is too large')

  for (const theme of themes) {
    const relativePath = `docs/images/themes/${theme}.jpg`
    const image = fs.readFileSync(path.join(projectRoot, relativePath))
    assert.match(readme, new RegExp(relativePath.replaceAll('.', '\\.')))
    assert.match(readmeEn, new RegExp(relativePath.replaceAll('.', '\\.')))
    assert.deepEqual(image.subarray(0, 2), Buffer.from([0xff, 0xd8]))
    assert.ok(image.length < 300 * 1024, `${theme} screenshot is too large`)
  }
  assert.doesNotMatch(readme, /docs\/images\/themes\/[^\s"')]+\.png/)
})

test('whale animation remains enabled with an accessibility fallback', () => {
  assert.match(css, /whale-figure \{ animation: whale-drift/)
  assert.match(css, /@keyframes whale-drift/)
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/)
  assert.match(css, /\.whale-figure, \.whale-bubbles \{ animation: none !important; \}/)
})

test('macOS package uses the custom whale icon', () => {
  const icon = fs.readFileSync(path.join(projectRoot, 'resources/app-icon.icns'))
  const packager = fs.readFileSync(path.join(projectRoot, 'scripts/package-mac.mjs'), 'utf8')
  assert.equal(icon.subarray(0, 4).toString('ascii'), 'icns')
  assert.match(packager, /icon: path\.join\(projectDirectory, 'resources', 'app-icon\.icns'\)/)
})

test('macOS package creates and verifies a drag-to-Applications DMG', () => {
  const script = fs.readFileSync(path.resolve(__dirname, '../scripts/package-mac.mjs'), 'utf8')
  assert.match(script, /DSH\.Tunnel-\$\{packageJson\.version\}-macos-\$\{architecture\}/)
  assert.match(script, /fs\.symlink\('\/Applications'/)
  assert.match(script, /'create',[\s\S]*'-fs', 'HFS\+'/)
  assert.match(script, /configureDmgWindow\(\)/)
  assert.match(script, /'convert',[\s\S]*'-format', 'UDZO'/)
  assert.match(script, /'verify', dmgPath/)
  assert.match(script, /'attach',[\s\S]*'-readonly'/)
  assert.match(script, /codesign[\s\S]*mountDirectory/)
  assert.match(script, /sha256\(dmgPath\)/)
  assert.match(script, /\.sha256/)
})

test('macOS package includes transparent menu bar template icons', () => {
  const oneX = fs.readFileSync(path.join(projectRoot, 'resources/trayTemplate.png'))
  const twoX = fs.readFileSync(path.join(projectRoot, 'resources/trayTemplate@2x.png'))
  const packager = fs.readFileSync(path.join(projectRoot, 'scripts/package-mac.mjs'), 'utf8')
  const main = fs.readFileSync(path.join(projectRoot, 'src/main.cjs'), 'utf8')
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.deepEqual(oneX.subarray(0, 8), pngSignature)
  assert.deepEqual(twoX.subarray(0, 8), pngSignature)
  assert.match(packager, /trayTemplate\.png/)
  assert.match(packager, /trayTemplate@2x\.png/)
  assert.match(main, /image\.setTemplateImage\(true\)/)
})

test('Windows package uses the whale icon and produces installer and portable artifacts', () => {
  const icon = fs.readFileSync(path.join(projectRoot, 'resources/app-icon.ico'))
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  assert.equal(icon.readUInt16LE(0), 0)
  assert.equal(icon.readUInt16LE(2), 1)
  assert.ok(icon.readUInt16LE(4) >= 8)
  assert.equal(packageJson.build.win.icon, 'resources/app-icon.ico')
  assert.equal(packageJson.build.win.target[0].target, 'nsis')
  assert.match(packageJson.scripts['package:win'], /icon:win/)
  assert.match(packageJson.scripts['package:win'], /nsis portable/)
  assert.equal(packageJson.build.nsis.artifactName, 'DSH-Tunnel-Setup-${version}-${arch}.${ext}')
  assert.equal(packageJson.build.portable.artifactName, 'DSH-Tunnel-Portable-${version}-${arch}.${ext}')
})
