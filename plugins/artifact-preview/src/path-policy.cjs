'use strict'

const PREVIEW_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.avif',
])

function reject(reason) {
  return Object.freeze({ disposition: 'reject', reason })
}

function classifyProducedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) {
    return reject('invalid-path')
  }
  if (value.includes('\0')) return reject('nul-byte')
  if (/^(?:\\\\|\/\/)/u.test(value)) return reject('network-or-device-path')

  const driveAbsolute = /^[A-Za-z]:[\\/]/u.test(value)
  const colonIndexes = [...value.matchAll(/:/gu)].map(match => match.index)
  if (colonIndexes.length > 0 && !(driveAbsolute && colonIndexes.length === 1 && colonIndexes[0] === 1)) {
    return reject('ambiguous-colon')
  }

  const components = value.split(/[\\/]+/u)
  const basename = components.at(-1)
  if (!basename) return reject('empty-basename')
  if (components.some(component => component !== '' && /[. ]$/u.test(component))) {
    return reject('trailing-dot-or-space')
  }

  const dot = basename.lastIndexOf('.')
  const extension = dot < 0 ? '' : basename.slice(dot).replace(/[A-Z]/gu, character => character.toLowerCase())
  if (PREVIEW_EXTENSIONS.has(extension)) {
    return Object.freeze({ disposition: 'preview', extension })
  }
  return Object.freeze({ disposition: 'native' })
}

module.exports = { PREVIEW_EXTENSIONS, classifyProducedPath }
