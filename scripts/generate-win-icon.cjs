const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const projectDirectory = path.resolve(__dirname, '..')
const source = path.join(projectDirectory, 'resources', 'app-icon.svg')
const destination = path.join(projectDirectory, 'resources', 'app-icon.ico')
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]

generateIcon().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

async function generateIcon() {
  const svg = fs.readFileSync(source)
  const frames = await Promise.all(sizes.map((size) => sharp(svg)
    .resize(size, size, { fit: 'fill' })
    .png()
    .toBuffer()))
  fs.writeFileSync(destination, createIco(frames, sizes))

  const previewIndex = process.argv.indexOf('--preview')
  if (previewIndex !== -1 && process.argv[previewIndex + 1]) {
    const preview = await sharp(svg).resize(512, 512, { fit: 'fill' }).png().toBuffer()
    fs.writeFileSync(path.resolve(process.argv[previewIndex + 1]), preview)
  }
  console.log(`Generated: ${destination}`)
}

function createIco(frames, frameSizes) {
  const headerSize = 6
  const entrySize = 16
  const directorySize = entrySize * frames.length
  const header = Buffer.alloc(headerSize + directorySize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(frames.length, 4)
  let imageOffset = header.length
  frames.forEach((frame, index) => {
    const size = frameSizes[index]
    const offset = headerSize + index * entrySize
    header.writeUInt8(size === 256 ? 0 : size, offset)
    header.writeUInt8(size === 256 ? 0 : size, offset + 1)
    header.writeUInt8(0, offset + 2)
    header.writeUInt8(0, offset + 3)
    header.writeUInt16LE(1, offset + 4)
    header.writeUInt16LE(32, offset + 6)
    header.writeUInt32LE(frame.length, offset + 8)
    header.writeUInt32LE(imageOffset, offset + 12)
    imageOffset += frame.length
  })
  return Buffer.concat([header, ...frames])
}
