import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { createZip, readBuild, renderPolicy } from './prepare-chrome-store.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'chrome-package-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = { manifest_version: 3, version: '1.0.0',
    background: { service_worker: 'background.js' },
    chrome_url_overrides: { newtab: 'index.html' }, icons: { 128: 'icon.png' } }
  mkdirSync(join(root, 'document'))
  for (const name of ['background.js', 'index.html', 'icon.png', 'document/index.html']) {
    writeFileSync(join(root, name), '')
  }
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest))
  return { root, manifest }
}

test('collects build files in stable order using ZIP-relative paths', t => {
  const { root, manifest } = fixture(t)
  assert.deepEqual(readBuild(root, manifest).files.map(file => file.name),
    ['background.js', 'document/index.html', 'icon.png', 'index.html', 'manifest.json'])
})

test('rejects missing builds, stale versions and missing manifest assets', t => {
  const { root, manifest } = fixture(t)
  assert.throws(() => readBuild(join(root, 'absent'), manifest), /build:chrome/)
  assert.throws(() => readBuild(root, { version: '2.0.0' }), /differs from source/)
  rmSync(join(root, 'background.js'))
  assert.throws(() => readBuild(root, manifest), /Missing manifest asset: background.js/)
})

test('rejects development files, credentials and remote HTML scripts', t => {
  const { root, manifest } = fixture(t)
  for (const name of ['.env.production', 'secret.key', 'debug.js.map', 'source.ts']) {
    writeFileSync(join(root, name), 'private')
    assert.throws(() => readBuild(root, manifest), /Unexpected source, credential or development file/)
    rmSync(join(root, name))
  }
  writeFileSync(join(root, 'index.html'), '<script src="https://example.com/script.js"></script>')
  assert.throws(() => readBuild(root, manifest), /Remote script/)
})

test('writes deterministic UTF-8 ZIP entries with valid DEFLATE and known CRC-32', () => {
  const files = [{ name: '目录/文档.md', data: Buffer.from('123456789') },
    { name: 'empty.txt', data: Buffer.alloc(0) }]
  const zip = createZip(files)
  assert.deepEqual(zip, createZip(files))
  assert.equal(zip.readUInt32LE(0), 0x04034b50)
  assert.equal(zip.readUInt16LE(6), 0x800)
  assert.equal(zip.readUInt32LE(14), 0xcbf43926)
  const nameLength = zip.readUInt16LE(26)
  assert.equal(zip.subarray(30, 30 + nameLength).toString('utf8'), files[0].name)
  assert.deepEqual(inflateRawSync(zip.subarray(30 + nameLength,
    30 + nameLength + zip.readUInt32LE(18))), files[0].data)
  const end = zip.length - 22
  assert.equal(zip.readUInt32LE(end), 0x06054b50)
  assert.equal(zip.readUInt16LE(end + 10), 2)
  const central = zip.readUInt32LE(end + 16)
  assert.equal(zip.readUInt32LE(central), 0x02014b50)
  assert.equal(zip.readUInt32LE(central + 16), 0xcbf43926)
  assert.equal(zip.readUInt32LE(central + 42), 0)
  const second = central + 46 + nameLength
  const secondLocal = zip.readUInt32LE(second + 42)
  assert.equal(zip.readUInt32LE(secondLocal), 0x04034b50)
  assert.equal(zip.readUInt32LE(second + 24), 0)
})

test('rejects unsafe paths and duplicate ZIP entries', () => {
  for (const name of ['', '/absolute', '../outside', 'a/../b', 'C:/secret', 'a\\b', 'a//b']) {
    assert.throws(() => createZip([{ name, data: Buffer.alloc(0) }]), /Invalid or duplicate ZIP path/)
  }
  const file = { name: 'same', data: Buffer.alloc(0) }
  assert.throws(() => createZip([file, file]), /Invalid or duplicate ZIP path/)
})

test('renders policy headings, lists and URLs while escaping embedded HTML', () => {
  const html = renderPolicy('# 标题 <script>\n\n## 章节\n- <img src=x>\n- https://example.com/policy\n\nA & B')
  assert.ok(html.includes('<title>标题 &lt;script&gt;</title>'))
  assert.ok(html.includes('<h2>章节</h2>'))
  assert.ok(html.includes('<li>&lt;img src=x&gt;</li>'))
  assert.ok(html.includes('<a href="https://example.com/policy">https://example.com/policy</a>'))
  assert.ok(html.includes('</ul>\n<p>A &amp; B</p>'))
  assert.ok(!html.includes('<script>'))
})
