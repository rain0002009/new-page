import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'
import { chromium } from '@playwright/test'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function readBuild(buildRoot, sourceManifest) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(buildRoot, 'manifest.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('Run pnpm build:chrome first.')
    throw error
  }
  if (manifest.manifest_version !== 3 || !/^\d+(\.\d+){0,3}$/.test(manifest.version)) {
    throw new Error('Expected a Manifest V3 release with a numeric version.')
  }
  if (manifest.version !== sourceManifest.version) {
    throw new Error('Build version differs from source. Rebuild before packaging.')
  }

  const files = []
  function collect(directory, prefix = '') {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name
      if (/(^|\/)(\.env[^/]*|node_modules|extension-profile[^/]*|\.git)(\/|$)/i.test(name) ||
          /\.(pem|key|pfx|p12|map|ts|tsx|log)$/i.test(name)) {
        throw new Error(`Unexpected source, credential or development file in build: ${name}`)
      }
      if (entry.isDirectory()) {
        collect(join(directory, entry.name), `${name}/`)
      } else {
        if (!entry.isFile()) throw new Error(`Unsupported build entry (including symlinks): ${name}`)
        const data = readFileSync(join(directory, entry.name))
        if (/\.html$/i.test(name) && /<script\b[^>]*\bsrc\s*=\s*["'](?:https?:|\/\/|data:)/i.test(data.toString('utf8'))) {
          throw new Error(`Remote script in ${name}`)
        }
        files.push({ name, data })
      }
    }
  }
  collect(buildRoot)
  files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const names = new Set(files.map(file => file.name))
  const required = [manifest.background?.service_worker, manifest.chrome_url_overrides?.newtab,
    'document/index.html', ...Object.values(manifest.icons ?? {})]
  for (const name of required) {
    if (!names.has(name)) throw new Error(`Missing manifest asset: ${name}`)
  }
  return { manifest, files }
}

// Classic ZIP: UTF-8 names, raw DEFLATE, CRC-32 and a central directory.
// Fixed DOS timestamps keep identical builds byte-for-byte reproducible.
export function createZip(files) {
  if (files.length >= 0xffff) throw new Error('Too many files for a classic ZIP.')
  const localParts = []
  const centralParts = []
  const names = new Set()
  let offset = 0
  let centralSize = 0
  for (const { name, data } of files) {
    if (!name || name.includes('\\') || name.startsWith('/') || name.includes(':') ||
        name.split('/').some(part => !part || part === '.' || part === '..') || names.has(name)) {
      throw new Error(`Invalid or duplicate ZIP path: ${name}`)
    }
    names.add(name)
    const encodedName = Buffer.from(name, 'utf8')
    const compressed = deflateRawSync(data, { level: 9 })
    if (encodedName.length > 0xffff || data.length >= 0xffffffff || compressed.length >= 0xffffffff) {
      throw new Error(`File exceeds classic ZIP limits: ${name}`)
    }
    const checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(0x21, 12) // 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(encodedName.length, 26)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    local.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    localParts.push(local, encodedName, compressed)
    centralParts.push(central, encodedName)
    offset += local.length + encodedName.length + compressed.length
    centralSize += central.length + encodedName.length
    if (offset + centralSize >= 0xffffffff) throw new Error('Archive exceeds classic ZIP limits.')
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, ...centralParts, end])
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

export function renderPolicy(markdown) {
  const lines = markdown.split(/\r?\n/)
  const inline = text => escapeHtml(text).replace(/https:\/\/[A-Za-z0-9./_-]+/g, '<a href="$&">$&</a>')
  const body = []
  let inList = false
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (!inList) body.push('<ul>')
      inList = true
      body.push(`<li>${inline(line.slice(2))}</li>`)
      continue
    }
    if (inList) body.push('</ul>')
    inList = false
    const heading = /^(#{1,2}) (.+)$/.exec(line)
    if (heading) {
      const level = heading[1].length
      body.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (line.trim()) body.push(`<p>${inline(line)}</p>`)
  }
  if (inList) body.push('</ul>')
  const title = escapeHtml(lines.find(line => line.startsWith('# '))?.slice(2) ?? 'Privacy policy')
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main>${body.join('\n')}</main></body></html>`
}

async function prepareScreenshots(assetsRoot) {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const page = await browser.newPage()
    for (const [index, name] of ['overview', 'tab-groups', 'notes', 'todo'].entries()) {
      const source = readFileSync(join(repoRoot, 'docs/images', `${name}.png`)).toString('base64')
      const png = await page.evaluate(async base64 => {
        const image = new Image()
        image.src = `data:image/png;base64,${base64}`
        await image.decode()
        const canvas = document.createElement('canvas')
        canvas.width = 1280
        canvas.height = 800
        const context = canvas.getContext('2d')
        context.fillStyle = '#f8faf4'
        context.fillRect(0, 0, 1280, 800)
        context.imageSmoothingQuality = 'high'
        const scale = Math.min(1280 / image.width, 800 / image.height)
        const width = Math.round(image.width * scale)
        const height = Math.round(image.height * scale)
        context.drawImage(image, Math.floor((1280 - width) / 2), Math.floor((800 - height) / 2), width, height)
        return canvas.toDataURL('image/png').split(',')[1]
      }, source)
      writeFileSync(join(assetsRoot, `0${index + 1}-${name}.png`), Buffer.from(png, 'base64'))
    }
  } finally {
    await browser.close()
  }
}

async function main() {
  const sourceManifest = JSON.parse(readFileSync(join(repoRoot, 'src/manifest.json'), 'utf8'))
  const { manifest, files } = readBuild(join(repoRoot, 'dist/chrome'), sourceManifest)
  const archive = createZip(files)
  const outputRoot = join(repoRoot, 'dist/chrome-store')
  const assetsRoot = join(outputRoot, 'assets')
  mkdirSync(assetsRoot, { recursive: true })
  await prepareScreenshots(assetsRoot)
  copyFileSync(join(repoRoot, 'src/images/icon-128.png'), join(assetsRoot, 'icon-128.png'))
  writeFileSync(join(outputRoot, 'privacy-policy.html'),
    renderPolicy(readFileSync(join(repoRoot, 'PRIVACY.md'), 'utf8')))
  const zip = `page-garden-${manifest.version}.zip`
  writeFileSync(join(repoRoot, 'dist', zip), archive)
  const info = {
    name: manifest.name,
    version: manifest.version,
    generatedAtUtc: new Date().toISOString(),
    zip: `../${zip}`,
    sha256: createHash('sha256').update(archive).digest('hex'),
    files: files.length,
    status: 'packaged',
  }
  const json = JSON.stringify(info, null, 2)
  writeFileSync(join(outputRoot, 'package-info.json'), `${json}\n`)
  console.log(json)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`Packaging failed: ${error.message}`)
    process.exitCode = 1
  })
}
