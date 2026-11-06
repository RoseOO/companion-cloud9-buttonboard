// Cloud9 / Symphony 24-button board (VID 0x2C82, PID 0x012D) protocol helpers.
//
// Reports are 65 bytes: [0x00][payload][0xFF padding to 64 bytes].
// Payload commands: 0x51 button, 0x52 LED, 0x53 LCD/page, 0x54 ticker,
// 0xA5 status, 0x88 input event.

export const VID = 0x2c82
export const PID = 0x012d

export const CMD = {
  BUTTON: 0x51,
  LED: 0x52,
  LCD: 0x53,
  TICKER: 0x54,
  STATUS: 0xa5,
  EVENT: 0x88,
}

export function normalizeDisplayText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[\u2010-\u2015]/g, '-') // dashes incl. em/en dash
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u2022\u00B7]/g, '*')
    .replace(/\u00A0/g, ' ')
    .replace(/\u2190/g, '<-')
    .replace(/\u2192/g, '->')
    .replace(/\u2191/g, '^')
    .replace(/\u2193/g, 'v')
    .replace(/[\u0080-\u009F]/g, '?')
    .replace(/[^\x00-\xFF]/g, '?')
}

export function alignTextLines(lines, width = 8, align = 'left') {
  return lines.map((line) => {
    const s = String(line ?? '').slice(0, width)
    if (align === 'right') return s.padStart(width)
    if (align === 'center') {
      const left = Math.floor((width - s.length) / 2)
      return ' '.repeat(left) + s + ' '.repeat(width - s.length - left)
    }
    return s.padEnd(width)
  })
}

export function textField(s, size) {
  const b = Buffer.alloc(size, 0)
  const src = Buffer.from(normalizeDisplayText(s), 'latin1')
  src.copy(b, 0, 0, Math.min(src.length, size - 1))
  return b
}

export function buttonPacket({
  index,
  lines = [],
  blinkRate = 0,
  textOn = 0xffff,
  textOff = 0xffff,
  bkgOn = 0x0000,
  bkgOff = 0x0000,
  borderOn = 0x0000,
  borderOff = 0x0000,
}) {
  const b = Buffer.alloc(52)
  b[0] = CMD.BUTTON
  b[1] = index & 0xff
  b[2] = blinkRate & 0xff
  b[3] = 0
  let off = 4
  for (let i = 0; i < 4; i++) {
    textField(lines[i] ?? '', 9).copy(b, off)
    off += 9
  }
  for (const c of [textOn, textOff, bkgOn, bkgOff, borderOn, borderOff]) {
    b.writeUInt16LE(c & 0xffff, off)
    off += 2
  }
  return b
}

export function lcdPacket({ enable = true, brightness = 200, page = 1 }) {
  return Buffer.from([CMD.LCD, enable ? 1 : 0, brightness & 0xff, page & 0xff])
}

export function ledPacket({
  index,
  enable,
  blinkDuty = 4,
  blinkPeriod = 0,
  intensity = 100,
}) {
  return Buffer.from([
    CMD.LED,
    index & 0xff,
    enable ? 1 : 0,
    blinkDuty & 0xff,
    blinkPeriod & 0xff,
    intensity & 0xff,
  ])
}

export function tickerPacket({ text, index = 0, enable = true }) {
  const b = Buffer.alloc(52)
  b[0] = CMD.TICKER
  b[1] = index & 0xff
  b[2] = enable ? 1 : 0
  b[3] = 0
  textField(text, 48).copy(b, 4)
  return b
}

export function statusRequest() {
  return Buffer.from([CMD.STATUS, 0])
}

export function toUsbReport(payload, reportId = 0) {
  const b = Buffer.alloc(65, 0xff)
  b[0] = reportId
  Buffer.from(payload).copy(b, 1, 0, Math.min(payload.length, 64))
  return b
}

export function normalizeInput(data) {
  const b = Buffer.from(data)
  if (b.length === 65 && b[0] === 0) return b.subarray(1)
  return b
}

// ---------------------------------------------------------------- colours
export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return { r: 0, g: 0, b: 0 }
  const n = parseInt(m[1], 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbTo565({ r, g, b }) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

export function luma565(c) {
  const r = ((c >> 11) & 31) * (255 / 31)
  const g = ((c >> 5) & 63) * (255 / 63)
  const b = (c & 31) * (255 / 31)
  return 0.299 * r + 0.587 * g + 0.114 * b
}

export function hexTo565(hex) {
  return rgbTo565(hexToRgb(hex))
}

// ---------------------------------------------------------------- layout
/**
 * Companion 8x4 layout: columns 1..6 are the 24 LCD keys, columns 0 and 7 are
 * the 4+4 side keys. Text-only style preset + background colour.
 */
export function buildLayout() {
  // The main 24 keys are physically two 6x2 blocks side by side: 12x2.
  const controls = {}
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 12; col++) {
      controls[`${row}/${col}`] = { row, column: col, stylePreset: 'default' }
    }
  }
  return {
    stylePresets: {
      // The bitmap is not displayed; it is used to detect Companion's red
      // error icon so the board can mirror it as a red border.
      default: { text: true, colors: 'hex', bitmap: { w: 32, h: 32, format: 'rgb' } },
    },
    controls,
  }
}

// ---------------------------------------------------------------- mapping
export function toButtonBoxIndex(view) {
  const n = view % 24
  if (n <= 6 || n > 12) {
    if (n <= 12 || n > 18) return n === 0 ? 23 : n - 1
    return n - 7
  }
  return n + 5
}

export const BOX_TO_VIEW = (() => {
  const a = new Array(24)
  for (let v = 1; v <= 24; v++) a[toButtonBoxIndex(v)] = v
  return a
})()

export function bitToBox(bit) {
  let n = bit % 4
  if (n === 0 || n === 2) n += 2
  return n * 6 - Math.floor(bit / 4)
}

export function bitToView(bit) {
  return BOX_TO_VIEW[bitToBox(bit)]
}

// Companion control id: "row/column", columns 0..7, rows 0..3.
// Center keys use columns 1..6; the 4+4 side keys use 0 and 7.
// The physical centre is two 6x2 blocks side by side, i.e. a 12x2 grid:
//   Companion row 0, columns 0-5  = left block, top row
//   Companion row 0, columns 6-11 = right block, top row
//   Companion row 1, columns 0-5  = left block, bottom row
//   Companion row 1, columns 6-11 = right block, bottom row
// The board's view order is left-top, right-top, left-bottom, right-bottom.
export function controlIdForBit(bit) {
  if (bit < 4 || bit > 27) return null // side keys are handled by the module
  const view = bitToView(bit)
  let viewRow = Math.floor((view - 1) / 6)
  const viewCol = (view - 1) % 6
  // The input bit order has the two middle physical rows crossed relative to
  // the render/label order. Mirror the 8x4 fix here.
  if (viewRow === 1) viewRow = 2
  else if (viewRow === 2) viewRow = 1
  const row = viewRow >= 2 ? 1 : 0
  const col = (viewRow % 2 === 0 ? 0 : 6) + viewCol
  return `${row}/${col}`
}

export function boxForControlId(controlId) {
  const [rowS, colS] = String(controlId).split('/')
  const row = Number(rowS)
  const col = Number(colS)
  if (!Number.isInteger(row) || !Number.isInteger(col)) return null
  if (row < 0 || row > 1 || col < 0 || col > 11) return null
  const block = col < 6 ? 0 : 1
  const viewCol = col % 6
  const viewRow = row * 2 + block
  return toButtonBoxIndex(viewRow * 6 + viewCol + 1)
}

// ---------------------------------------------------------------- text
export function wrapText(text, width = 8, maxLines = 4) {
  const paragraphs = normalizeDisplayText(text).split('\n')
  const lines = []
  for (const para of paragraphs) {
    if (lines.length >= maxLines) break
    if (!para) {
      lines.push('')
      continue
    }
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word
      else if ((line + ' ' + word).length <= width) line += ' ' + word
      else {
        lines.push(line.slice(0, width))
        line = word
      }
      while (line.length > width) {
        lines.push(line.slice(0, width))
        line = line.slice(width)
      }
    }
    if (line && lines.length < maxLines) lines.push(line.slice(0, width))
  }
  while (lines.length < maxLines) lines.push('')
  return lines.slice(0, maxLines)
}
