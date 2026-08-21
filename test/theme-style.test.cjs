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

test('macOS package uses the custom whale icon', () => {
  const icon = fs.readFileSync(path.join(projectRoot, 'resources/app-icon.icns'))
  const packager = fs.readFileSync(path.join(projectRoot, 'scripts/package-mac.mjs'), 'utf8')
  assert.equal(icon.subarray(0, 4).toString('ascii'), 'icns')
  assert.match(packager, /icon: path\.join\(projectDirectory, 'resources', 'app-icon\.icns'\)/)
})
