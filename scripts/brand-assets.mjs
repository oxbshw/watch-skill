#!/usr/bin/env node
/**
 * Derive the Watch Workspace brand assets from the supplied orca master.
 *
 * The master arrived as a 1254×1254 PNG with **no alpha channel**. What looks
 * like transparency is a checkerboard painted into the pixels — two near-white
 * greys, #fefefe and #f6f6f6, on a ~31px grid. Shipping it unchanged would put
 * an opaque grey chequer behind the mark on every surface.
 *
 * So the alpha is recovered rather than keyed, and the distinction that makes
 * that possible is worth stating, because getting it backwards destroys the
 * artwork:
 *
 *   - The **belly** is genuinely negative space. Sampling it returns the same
 *     #f6f6f6 / #fefefe pair as the background, on the same grid: the artwork
 *     simply does not draw there, and the chequer shows through. It must end up
 *     transparent.
 *   - The **eye patch** is painted white. It samples uniformly at ~#fdfdfd with
 *     none of the darker chequer square, and it is fully enclosed by blue. It
 *     must end up opaque white.
 *
 * Both are "light pixels", so no colour threshold can separate them. What
 * separates them is reachability: the background is connected to the image
 * border and the eye patch is not. A flood fill from the border over light
 * pixels finds exactly the background — belly included, eye patch excluded.
 *
 * Edge pixels are a blend of blue and chequer. The blue channel is useless for
 * recovering coverage (252 against a 247 ground); the **red** channel spans 49
 * to 247, so coverage is read from red and the colour is restored to the pure
 * master blue. That keeps the silhouette's antialiasing instead of producing a
 * hard-edged cut-out.
 *
 * Nothing here redraws, recolours, crops or reproportions the mark. Every
 * output is the same artwork at a different size, and the sizes exist only
 * because the platforms demand them.
 *
 * Usage:
 *   node scripts/brand-assets.mjs <master.png>   derive and write every asset
 *   node scripts/brand-assets.mjs --check        fail if the assets are stale
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync, deflateSync } from 'node:zlib'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'packages', 'watch', 'brand', 'assets')

/** The master's own blue, sampled from its body. Not chosen — measured. */
const MASTER_BLUE = [49, 96, 252]

/** Sizes the platforms actually ask for. */
const SIZES = [512, 256, 128, 64, 48, 32, 16]

/** Sizes Windows packs into an .ico. */
const ICO_SIZES = [256, 64, 48, 32, 16]

// ── PNG ─────────────────────────────────────────────────────────────────────

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const out = Buffer.alloc(data.length + 12)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'ascii')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.slice(4, 8 + data.length)), 8 + data.length)
  return out
}

/** Decode a PNG into flat pixels. Handles the colour types a logo can be. */
export function decodePng(file) {
  const b = readFileSync(file)
  if (b.slice(1, 4).toString() !== 'PNG') throw new Error(`${file} is not a PNG`)
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), depth = b[24], type = b[25]
  if (depth !== 8) throw new Error(`unsupported bit depth ${String(depth)}`)
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type]
  if (ch === undefined) throw new Error(`unsupported colour type ${String(type)}`)

  let off = 8
  const idat = []
  while (off < b.length - 8) {
    const len = b.readUInt32BE(off)
    const t = b.slice(off + 4, off + 8).toString('ascii')
    if (t === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len))
    if (t === 'IEND') break
    off += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const px = Buffer.alloc(h * stride)
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const left = x >= ch ? px[y * stride + x - ch] : 0
      const up = y > 0 ? px[(y - 1) * stride + x] : 0
      const upLeft = (y > 0 && x >= ch) ? px[(y - 1) * stride + x - ch] : 0
      let v = raw[src + x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const da = Math.abs(p - left), db = Math.abs(p - up), dc = Math.abs(p - upLeft)
        v += (da <= db && da <= dc) ? left : (db <= dc ? up : upLeft)
      }
      px[y * stride + x] = v & 255
    }
  }
  return { w, h, ch, px }
}

/** Encode RGBA pixels as a PNG. Filter 0 throughout: small images, clear code. */
function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// ── alpha recovery ──────────────────────────────────────────────────────────

/** A near-white, near-neutral pixel: either chequer or painted white. */
function isLight(r, g, b) {
  return Math.max(r, g, b) > 232 && (Math.max(r, g, b) - Math.min(r, g, b)) < 14
}

/**
 * Recover an alpha channel from the painted chequerboard.
 *
 * Returns RGBA at the master's own size. See the module note for why the
 * background is found by reachability rather than by colour.
 */
export function recoverAlpha({ w, h, ch, px }) {
  const light = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) {
    const o = i * ch
    if (isLight(px[o], px[o + 1], px[o + 2])) light[i] = 1
  }

  // Flood fill the light region that touches the border. That is the
  // background: the belly is part of it, the enclosed eye patch is not.
  const background = new Uint8Array(w * h)
  const queue = []
  const push = (x, y) => {
    const i = y * w + x
    if (x < 0 || y < 0 || x >= w || y >= h) return
    if (background[i] === 1 || light[i] === 0) return
    background[i] = 1
    queue.push(i)
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (queue.length > 0) {
    const i = queue.pop()
    const x = i % w, y = (i - x) / w
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
  }

  // The ground the artwork was composited over, for reading edge coverage.
  const GROUND_R = 247
  const out = Buffer.alloc(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const o = i * ch, q = i * 4
    const r = px[o], g = px[o + 1], b = px[o + 2]
    if (background[i] === 1) continue // left as 0,0,0,0

    if (light[i] === 1) {
      // Enclosed light: the painted eye patch.
      out[q] = 255; out[q + 1] = 255; out[q + 2] = 255; out[q + 3] = 255
      continue
    }

    // Coverage from the red channel, which spans 49→247 rather than 252→247.
    const coverage = (GROUND_R - r) / (GROUND_R - MASTER_BLUE[0])
    const alpha = Math.max(0, Math.min(1, coverage))
    if (alpha > 0.985) {
      out[q] = r; out[q + 1] = g; out[q + 2] = b; out[q + 3] = 255
    } else {
      // Un-composite to the master blue so the edge keeps its shape without
      // dragging the chequer's grey into the halo.
      out[q] = MASTER_BLUE[0]
      out[q + 1] = MASTER_BLUE[1]
      out[q + 2] = MASTER_BLUE[2]
      out[q + 3] = Math.round(alpha * 255)
    }
  }
  return { w, h, rgba: out }
}

/**
 * Box-filter down to `size`, in premultiplied space.
 *
 * Averaging straight RGBA would pull the transparent pixels' colour into the
 * edge and leave a dark fringe; premultiplying is what keeps the silhouette
 * clean at 16px.
 */
export function resize({ w, h, rgba }, size) {
  const out = Buffer.alloc(size * size * 4)
  const sx = w / size, sy = h / size
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          const o = (yy * w + xx) * 4
          const al = rgba[o + 3] / 255
          r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al
          n += 1
        }
      }
      const q = (y * size + x) * 4
      if (n === 0 || a === 0) continue
      out[q] = Math.round(r / a)
      out[q + 1] = Math.round(g / a)
      out[q + 2] = Math.round(b / a)
      out[q + 3] = Math.round((a / n) * 255)
    }
  }
  return { w: size, h: size, rgba: out }
}

/** A Windows .ico holding PNG-compressed entries. */
function encodeIco(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  const bodies = []
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header[entry] = size >= 256 ? 0 : size
    header[entry + 1] = size >= 256 ? 0 : size
    header[entry + 2] = 0
    header[entry + 3] = 0
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
    bodies.push(png)
  })
  return Buffer.concat([header, ...bodies])
}

// ── entry ───────────────────────────────────────────────────────────────────

function main() {
  const check = process.argv.includes('--check')
  const master = process.argv.find(a => a.endsWith('.png') && !a.startsWith('--'))
    ?? join(OUT_DIR, 'watch-orca-master.png')

  if (!existsSync(master)) {
    process.stderr.write(`watch: brand master not found: ${master}\n`)
    process.exit(1)
  }

  const decoded = decodePng(master)
  const recovered = decoded.ch === 4
    ? { w: decoded.w, h: decoded.h, rgba: decoded.px }
    : recoverAlpha(decoded)

  mkdirSync(OUT_DIR, { recursive: true })
  const written = []
  const variants = new Map()

  for (const size of SIZES) {
    const scaled = resize(recovered, size)
    const png = encodePng(size, size, scaled.rgba)
    variants.set(size, png)
    const path = join(OUT_DIR, `watch-orca-${String(size)}.png`)
    if (check) {
      if (!existsSync(path) || !readFileSync(path).equals(png)) {
        process.stderr.write(`watch: ${path} is stale — run \`node scripts/brand-assets.mjs\`\n`)
        process.exit(1)
      }
    } else {
      writeFileSync(path, png)
    }
    written.push([`watch-orca-${String(size)}.png`, png.length, size])
  }

  const ico = encodeIco(ICO_SIZES.map(size => ({ size, png: variants.get(size) })))
  const icoPath = join(OUT_DIR, 'watch-orca.ico')
  if (check) {
    if (!existsSync(icoPath) || !readFileSync(icoPath).equals(ico)) {
      process.stderr.write('watch: watch-orca.ico is stale\n')
      process.exit(1)
    }
    process.stdout.write(`brand: assets current — ${String(SIZES.length)} PNG(s) + 1 ICO\n`)
    return
  }
  writeFileSync(icoPath, ico)

  // The mark the client bundle inlines. 64px covers a 32px slot at 2x, and
  // inlining keeps the identity correct on the first paint of an offline
  // profile — a mark that needs a fetch is a mark that is sometimes missing.
  const inline = `data:image/png;base64,${variants.get(64).toString('base64')}`
  // Emitted as a TypeScript module rather than an asset the bundler copies.
  //
  // The client bundle is served to a browser by the DSH Host, and a mark that
  // needs a second request is a mark that is sometimes missing — on the first
  // paint, on a cold offline profile, behind a slow loopback. Inlining makes
  // the identity correct before anything else has loaded.
  const blueHex = MASTER_BLUE.map(v => v.toString(16).padStart(2, '0')).join('')
  const moduleSource = [
    '/**',
    ' * The Watch mark, inlined.',
    ' *',
    ' * Generated by `scripts/brand-assets.mjs` from `assets/watch-orca-master.png`.',
    ' * Do not edit by hand: the master is the brand source of truth and this is a',
    ' * mechanical derivation of it at 64px, which covers a 32px slot at 2x.',
    ' *',
    ' * @module @watchskill/dsh-client-brand/mark',
    ' */',
    '',
    '/** The orca, as a transparent PNG data URI. */',
    `export const WATCH_MARK_PNG = '${inline}'`,
    '',
    "/** The master artwork's own blue. Measured from it, never chosen. */",
    `export const MASTER_BLUE = '#${blueHex}'`,
    '',
  ].join('\n')
  const modulePath = join(ROOT, 'packages', 'watch', 'brand', 'src', 'mark.ts')
  if (check) {
    if (!existsSync(modulePath) || readFileSync(modulePath, 'utf8') !== moduleSource) {
      process.stderr.write('watch: packages/watch/brand/src/mark.ts is stale\n')
      process.exit(1)
    }
  } else {
    writeFileSync(modulePath, moduleSource, 'utf8')
  }

  process.stdout.write(
    `brand: derived from ${master}\n`
    + written.map(([name, bytes, size]) =>
      `  ${name.padEnd(24)} ${String(size).padStart(4)}px  ${String(bytes).padStart(7)} bytes\n`).join('')
    + `  watch-orca.ico           ${String(ICO_SIZES.length)} entries  ${String(ico.length).padStart(7)} bytes\n`
    + `  mark.inline.txt          ${String(inline.length)} chars (64px, base64)\n`,
  )
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('brand-assets.mjs')) main()
