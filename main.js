// Bitfocus Companion surface module for the Cloud9 / Symphony 24-button board.
//
// Companion 5.1 surface API v1.4.0. The device is a single vendor HID
// collection (usage page 0xFF00) with 65-byte reports:
//
//   [0x00][command + payload][0xFF padding to 64 bytes]
//
// The module declares an 8x4 Companion grid: columns 1..6 are the 24 LCD keys,
// column 0 and column 7 are the 4+4 side keys. Companion sends text + a hex
// background colour (style preset `text` + `colors`), which we write to the
// board's 4-line x 8-character button displays.

import { createRequire } from 'node:module'

import {
  VID,
  PID,
  buttonPacket,
  lcdPacket,
  ledPacket,
  toUsbReport,
  normalizeInput,
  statusRequest,
  hexTo565,
  luma565,
  controlIdForBit,
  boxForControlId,
  wrapText,
  alignTextLines,
  buildLayout,
  CMD,
} from './protocol.js'

const require = createRequire(import.meta.url)
const { HID } = require('node-hid')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function imageHasErrorIcon(image, w = 32, h = 32) {
  if (!image || image.length < w * h * 3) return false
  // Companion draws its error as a red triangle in the top-right corner.
  let red = 0
  const x0 = Math.floor(w * 0.5)
  const y1 = Math.ceil(h * 0.55)
  for (let y = 0; y < y1; y++) {
    for (let x = x0; x < w; x++) {
      const i = (y * w + x) * 3
      const r = image[i]
      const g = image[i + 1]
      const b = image[i + 2]
      if (r > 140 && g < 110 && b < 110) red++
    }
  }
  return red >= 3
}

const LAYOUT = buildLayout()

const CONFIG_FIELDS = [
  {
    type: 'static-text',
    id: 'pageKeysInfo',
    label: 'Page hotkeys',
    value: 'Left column top-to-bottom. Set a page number, or 0 to disable a key.',
  },
  { type: 'number', id: 'left1Page', label: 'Left 1 -> page', default: 1, min: 0, max: 99, step: 1 },
  { type: 'number', id: 'left2Page', label: 'Left 2 -> page', default: 2, min: 0, max: 99, step: 1 },
  { type: 'number', id: 'left3Page', label: 'Left 3 -> page', default: 3, min: 0, max: 99, step: 1 },
  { type: 'number', id: 'left4Page', label: 'Left 4 -> page', default: 4, min: 0, max: 99, step: 1 },
  { type: 'number', id: 'homePage', label: 'Home page (bottom-right menu)', default: 1, min: 1, max: 99, step: 1 },
  {
    type: 'dropdown',
    id: 'textAlign',
    label: 'Text alignment',
    default: 'left',
    choices: [
      { id: 'left', label: 'Left' },
      { id: 'center', label: 'Centre' },
      { id: 'right', label: 'Right' },
    ],
  },
  {
    type: 'textinput',
    id: 'alignOverrides',
    label: 'Per-button alignment overrides',
    default: '',
    description: 'Comma-separated, e.g. 0/4:center,1/5:right',
  },
  {
    type: 'checkbox',
    id: 'showPlaceholder',
    label: 'Show page/row/column on unused buttons',
    default: true,
    description: 'Turn off to leave unassigned buttons blank.',
  },
  {
    type: 'textinput',
    id: 'lockBackground',
    label: 'Lock / PIN screen background',
    default: '#141a20',
    description: 'Hex colour for the pincode digit keys. Defaults to a dark grey.',
  },
  {
    type: 'static-text',
    id: 'targetInfo',
    label: 'Second use / Companion targets',
    value:
      'Set page/row/column (e.g. 1/0/3) to make a side key hold/release that Companion button. Row/column are 0-based. Requires Companion\'s HTTP API to be enabled.',
  },
  { type: 'textinput', id: 'left1Target', label: 'Left 1 target', default: '' },
  { type: 'textinput', id: 'left2Target', label: 'Left 2 target', default: '' },
  { type: 'textinput', id: 'left3Target', label: 'Left 3 target', default: '' },
  { type: 'textinput', id: 'left4Target', label: 'Left 4 target', default: '' },
  { type: 'number', id: 'rightTopPage', label: 'Right top toggle -> page (0 = none)', default: 0, min: 0, max: 99, step: 1 },
  { type: 'textinput', id: 'rightTopTarget', label: 'Right top toggle target', default: '' },
  { type: 'textinput', id: 'pageUpTarget', label: 'Page Up target (overrides page up)', default: '' },
  { type: 'textinput', id: 'pageDownTarget', label: 'Page Down target (overrides page down)', default: '' },
  { type: 'textinput', id: 'homeTarget', label: 'Home target (overrides home page)', default: '' },
  {
    type: 'textinput',
    id: 'apiUrl',
    label: 'Companion API URL',
    default: 'http://127.0.0.1:8000',
    description: 'Include the port, e.g. http://127.0.0.1:8000 (use Companion\'s configured http_port).',
  },
  {
    type: 'textinput',
    id: 'apiToken',
    label: 'Companion API token',
    default: '',
    description: 'Optional for the local /api press endpoint; not required.',
  },
]

// Companion's lock screen (pincode) draws the digits itself and routes presses
// on these controls to pincode entry, so no custom entry logic is needed.
// Keep the whole lock UI on the left bank: 1-5 on the top row, 6-0 on the
// bottom row, and the asterisk / "Lockout" display at the bottom-right of the
// bank (1/5).
const PINCODE_MAP = {
  type: 'single-page',
  pincode: '1/5',
  0: '1/4',
  1: '0/0',
  2: '0/1',
  3: '0/2',
  4: '0/3',
  5: '0/4',
  6: '1/0',
  7: '1/1',
  8: '1/2',
  9: '1/3',
}

class Cloud9Surface {
  constructor(surfaceId, pluginInfo, context) {
    this.surfaceId = surfaceId
    this.productName = pluginInfo.product || 'Cloud9 Button Board (0301)'
    this._info = pluginInfo
    this._context = context
    this._hid = null
    this._closed = false
    this._brightness = 200
    this._page = 1
    this._lastMap = 0
    this._pressed = new Set()
    this._lastDraw = new Map()
    this._pending = new Map()
    this._draining = false
    this._pageCooldown = false
    this._config = {
      left1Page: 1,
      left2Page: 2,
      left3Page: 3,
      left4Page: 4,
      homePage: 1,
      textAlign: 'left',
      alignOverrides: '',
      showPlaceholder: true,
      lockBackground: '#141a20',
      left1Target: '',
      left2Target: '',
      left3Target: '',
      left4Target: '',
      rightTopPage: 0,
      rightTopTarget: '',
      pageUpTarget: '',
      pageDownTarget: '',
      homeTarget: '',
      apiUrl: 'http://127.0.0.1:8000',
      apiToken: '',
    }
    this._jumpTimer = null
    this._jumpTarget = null
    this._heldTargets = new Map()
    this._alignOverrides = new Map()
    this._lockLabelShown = false
  }

  // -------------------------------------------------------------- lifecycle
  async init() {
    this._hid = new HID(this._info.path)
    this._hid.on('data', (data) => this._onData(data))
    this._hid.on('error', (err) => {
      if (!this._closed) this._context.disconnect(err instanceof Error ? err : new Error(String(err)))
    })

    // backlight on, status LED, ask for firmware/status (ignored unless logged)
    await this._write(lcdPacket({ enable: true, brightness: this._brightness, page: this._page }))
    await this._write(ledPacket({ index: 3, enable: true }))
    await this._write(statusRequest())
  }

  async ready() {}

  async updateConfig(config) {
    this._config = { ...this._config, ...(config || {}) }
    this._alignOverrides.clear()
    for (const part of String(this._config.alignOverrides || '').split(',')) {
      const [id, align] = part.split(':').map((s) => s.trim())
      if (id && ['left', 'center', 'right'].includes(align)) {
        this._alignOverrides.set(id, align)
      }
    }
    // Apply alignment changes immediately instead of waiting for a page redraw.
    for (const controlId of this._lastDraw.keys()) {
      this._enqueue(controlId, () => this._renderNow(controlId))
    }
  }

  _alignmentFor(controlId) {
    return (
      this._alignOverrides.get(controlId) ||
      (['left', 'center', 'right'].includes(this._config.textAlign)
        ? this._config.textAlign
        : 'left')
    )
  }

  async close() {
    try {
      await this._blankNow(true)
    } catch {
      // ignore
    }
    this._closed = true
    try {
      this._hid?.close()
    } catch {
      // ignore
    }
    this._hid = null
  }

  // ---------------------------------------------------------------- output
  async setBrightness(percent) {
    this._brightness = Math.max(0, Math.min(255, Math.round(percent * 2.55)))
    await this._write(
      lcdPacket({
        enable: this._brightness > 0,
        brightness: this._brightness,
        page: this._page,
      }),
    )
  }

  async blank() {
    // Companion calls blank() after setBrightness(); clearing must not turn the
    // backlight off or the following draws are invisible.
    await this._blankNow(false)
  }

  // Companion only calls this when a pincode map is registered. On unlock it
  // redraws the page; reset first so digits from the lock screen do not linger
  // on controls Companion does not redraw.
  showLockedStatus(locked) {
    this._pressed.clear()
    this._lockLabelShown = false
    if (!locked) this._resetPage(this._page)
  }

  async _blankNow(turnOff) {
    for (let box = 0; box < 24; box++) {
      await this._write(
        buttonPacket({
          index: box,
          lines: ['', '', '', ''],
          textOn: 0x0000,
          textOff: 0x0000,
          bkgOn: 0x0000,
          bkgOff: 0x0000,
          borderOn: 0x0000,
          borderOff: 0x0000,
        }),
      )
    }
    await this._write(
      lcdPacket({
        enable: !turnOff,
        brightness: turnOff ? 0 : this._brightness,
        page: this._page,
      }),
    )
  }

  async draw(signal, drawProps) {
    if (signal?.aborted || this._closed) return
    if (drawProps.pageNumber && drawProps.pageNumber !== this._page) {
      this._page = drawProps.pageNumber
      this._resetPage(this._page)
      this._enqueue('page', () =>
        this._write(lcdPacket({ enable: true, brightness: this._brightness, page: this._page })),
      )
    }

    const box = boxForControlId(drawProps.controlId)
    if (box === null) return // side key has no LCD; it is input-only

    const [rowS, colS] = String(drawProps.controlId).split('/')
    const color = drawProps.color || '#000000'
    const isBlank = !drawProps.text && /^#?0{6}$/i.test(color)
    let bg
    let fg
    let lines
    if (isBlank) {
      // Unassigned button: show Companion's page/row/column on black.
      const page = drawProps.pageNumber ?? this._page ?? 1
      bg = 0x0000
      fg = 0x8410
      lines = [`${page}/${rowS}/${colS}`, '', '', '']
    } else {
      // Assigned/edited button: keep the colour even if it has no text
      // (Companion often sends feedback colour changes with empty text).
      bg = hexTo565(color)
      fg = luma565(bg) > 140 ? 0x0000 : 0xffff
      lines = drawProps.text ? wrapText(drawProps.text, 8, 4) : ['', '', '', '']
    }
    this._lastDraw.set(drawProps.controlId, {
      box,
      lines,
      fg,
      bg,
      placeholder: isBlank,
      locked: this._context.isLocked,
      error: imageHasErrorIcon(drawProps.image),
    })

    // The lock screen leaves the top-right key of the left bank free, so use
    // it to show that the surface is locked. Queue it alongside the first
    // pincode draw, after Companion's blank() for the lock screen has run.
    if (this._context.isLocked && drawProps.text && !this._lockLabelShown) {
      this._lockLabelShown = true
      const labelId = '0/5'
      const labelBox = boxForControlId(labelId)
      if (labelBox !== null) {
        this._lastDraw.set(labelId, {
          box: labelBox,
          lines: ['LOCKED', '', '', ''],
          fg: 0xffff,
          bg: 0x0000,
          placeholder: false,
          locked: true,
          error: false,
        })
        this._enqueue(labelId, () => this._renderNow(labelId))
      }
    }

    this._enqueue(drawProps.controlId, () => this._renderNow(drawProps.controlId))
  }

  _renderNow(controlId) {
    const state = this._lastDraw.get(controlId)
    if (!state) return
    // Unassigned buttons can be hidden entirely instead of showing page/row/col.
    const hidePlaceholder = state.placeholder && !this._config.showPlaceholder
    // Companion's lock screen draws its digits on white. Substitute the
    // configured dark background (recomputed here so setting changes apply live).
    let fg = state.fg
    let bg = state.bg
    if (state.locked && !state.placeholder) {
      bg = hexTo565(this._config.lockBackground || '#141a20')
      fg = luma565(bg) > 140 ? 0x0000 : 0xffff
    }
    const lines = hidePlaceholder
      ? ['', '', '', '']
      : alignTextLines(state.lines, 8, this._alignmentFor(controlId))
    const border = this._pressed.has(controlId)
      ? 0xffe0 // yellow while held
      : state.error
        ? 0xf800 // Companion error state
        : bg
    return this._write(
      buttonPacket({
        index: state.box,
        lines,
        textOn: fg,
        textOff: fg,
        bkgOn: bg,
        bkgOff: bg,
        borderOn: border,
        borderOff: border,
      }),
    )
  }

  _resetPage(page) {
    // Companion may not redraw empty controls on a page change, so clear all
    // 24 centre keys to their page/row/column placeholder first.
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 12; col++) {
        const id = `${row}/${col}`
        const box = boxForControlId(id)
        if (box === null) continue
        this._lastDraw.set(id, {
          box,
          lines: [`${page}/${row}/${col}`, '', '', ''],
          fg: 0x8410,
          bg: 0x0000,
          placeholder: true,
          locked: false,
          error: false,
        })
        this._enqueue(id, () => this._renderNow(id))
      }
    }
  }

  _changePage(forward) {
    this._clearJump()
    if (this._pageCooldown) return
    this._pageCooldown = true
    this._context.changePage(forward)
    setTimeout(() => {
      this._pageCooldown = false
    }, 250)
  }

  _clearJump() {
    if (this._jumpTimer) clearTimeout(this._jumpTimer)
    this._jumpTimer = null
    this._jumpTarget = null
  }

  _jumpToPage(target) {
    const page = Number(target)
    if (!Number.isFinite(page) || page < 1) return
    this._clearJump()
    this._jumpTarget = page
    this._jumpStep()
  }

  _jumpStep() {
    const target = this._jumpTarget
    if (target === null || this._closed) return
    const current = Number(this._page) || 1
    if (current === target) {
      this._jumpTarget = null
      return
    }

    const before = current
    this._context.changePage(target > current)
    const started = Date.now()

    const poll = () => {
      if (this._closed || this._jumpTarget !== target) return
      const nowPage = Number(this._page) || 1
      if (nowPage !== before) {
        if (nowPage === target) {
          this._jumpTarget = null
        } else {
          this._jumpTimer = setTimeout(() => this._jumpStep(), 25)
        }
        return
      }
      // The host has not redrawn the new page yet. Wait for it, then retry if
      // it seems the relative change was dropped.
      const retry = Date.now() - started > 700
      this._jumpTimer = setTimeout(retry ? () => this._jumpStep() : poll, 40)
    }

    this._jumpTimer = setTimeout(poll, 40)
  }

  _targetAction(target, action) {
    const match = /^(\d+)\/(\d+)\/(\d+)$/.exec(String(target || '').trim())
    if (!match) return
    const base = String(this._config.apiUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '')
    const url = `${base}/api/location/${match[1]}/${match[2]}/${match[3]}/${action}`
    const headers = {}
    const token = String(this._config.apiToken || '').trim()
    if (token) headers.Authorization = `Bearer ${token}`
    fetch(url, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(2500),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          console.error('Cloud9 target action failed:', action, res.status, body)
        }
      })
      .catch((err) => console.error('Cloud9 target action failed:', action, err))
  }

  _sideTarget(bit) {
    if (bit === 0) return String(this._config.rightTopTarget || '').trim()
    if (bit === 1) return String(this._config.pageUpTarget || '').trim()
    if (bit === 2) return String(this._config.pageDownTarget || '').trim()
    if (bit === 3) return String(this._config.homeTarget || '').trim()
    if (bit >= 28 && bit <= 31) {
      return String(this._config[`left${bit - 28 + 1}Target`] || '').trim()
    }
    return ''
  }

  // ---------------------------------------------------------------- input
  _onData(data) {
    if (this._closed) return
    const d = normalizeInput(data)
    if (!d.length || d[0] !== CMD.EVENT || d.length < 8) return

    const map = d.readUInt32LE(4)
    const changed = (map ^ this._lastMap) >>> 0
    this._lastMap = map >>> 0
    if (!changed) return

    for (let bit = 0; bit < 32; bit++) {
      if (!(changed & (1 << bit))) continue
      const down = (map & (1 << bit)) !== 0

      if (!down) {
        if (this._heldTargets.has(bit)) {
          this._targetAction(this._heldTargets.get(bit), 'up')
          this._heldTargets.delete(bit)
          continue
        }
        // Main keys use down/up events.
        const id = controlIdForBit(bit)
        if (id) {
          this._pressed.delete(id)
          this._enqueue(id, () => this._renderNow(id))
          this._context.keyUpById(id)
        }
        continue
      }

      // While locked, only the main keys are useful: Companion turns them into
      // pincode digits. Do not run side-key targets or page changes, which
      // would bypass the lock.
      const isSideKey = bit < 4 || (bit >= 28 && bit <= 31)
      if (this._context.isLocked && isSideKey) continue

      // Side keys with a configured target act as that Companion button,
      // including hold and release.
      const sideTarget = this._sideTarget(bit)
      if (sideTarget) {
        this._targetAction(sideTarget, 'down')
        this._heldTargets.set(bit, sideTarget)
        continue
      }

      // Physical right column, top->bottom = bits 0,1,2,3.
      if (bit === 0) {
        const page = Number(this._config.rightTopPage) || 0
        if (page > 0) this._jumpToPage(page)
        continue
      }
      if (bit === 1 || bit === 2) {
        this._changePage(bit === 1)
        continue
      }
      if (bit === 3) {
        this._jumpToPage(this._config.homePage)
        continue
      }

      // Physical left column, top->bottom = bits 28,29,30,31.
      if (bit >= 28 && bit <= 31) {
        this._jumpToPage(this._config[`left${bit - 28 + 1}Page`])
        continue
      }

      // 24 main keys.
      const id = controlIdForBit(bit)
      if (!id) continue
      if (!this._pressed.has(id)) {
        this._pressed.add(id)
        this._enqueue(id, () => this._renderNow(id))
        this._context.keyDownById(id)
      }
    }

    // Reconcile against the full input map. If a release report is missed,
    // this clears the yellow border on the next input event instead of leaving
    // the key highlighted.
    const held = new Set()
    for (let bit = 4; bit <= 27; bit++) {
      if (map & (1 << bit)) {
        const id = controlIdForBit(bit)
        if (id) held.add(id)
      }
    }
    for (const id of [...this._pressed]) {
      if (!held.has(id)) {
        this._pressed.delete(id)
        this._enqueue(id, () => this._renderNow(id))
      }
    }
  }

  // ---------------------------------------------------------------- wire
  async _write(payload) {
    if (!this._hid || this._closed) return
    try {
      this._hid.write(toUsbReport(payload))
    } catch (err) {
      console.error('Cloud9 button board write failed:', err)
      throw err
    }
  }

  _enqueue(key, fn) {
    this._pending.set(key, fn)
    if (!this._draining) {
      this._draining = true
      this._drain().catch(() => {
        this._draining = false
      })
    }
  }

  async _drain() {
    while (this._pending.size && !this._closed) {
      const [key, fn] = this._pending.entries().next().value
      this._pending.delete(key)
      try {
        await fn()
      } catch (err) {
        if (!this._closed) this._context.disconnect(err instanceof Error ? err : new Error(String(err)))
        break
      }
      // The board's HID parser is not fast; keep writes spaced out.
      await sleep(8)
    }
    this._draining = false
  }
}

const plugin = {
  async init() {},
  async destroy() {},

  checkSupportsHidDevice(device) {
    if (device.vendorId !== VID || device.productId !== PID) return null
    if (device.usagePage !== undefined && device.usagePage !== 0xff00) return null
    return {
      surfaceId: `cloud9-buttonboard:${device.serialNumber || device.path}`,
      surfaceIdIsNotUnique: false,
      description: device.product || 'Cloud9 Button Board (0301)',
      pluginInfo: {
        path: device.path,
        product: device.product,
        productId: device.productId,
      },
    }
  },

  async openSurface(surfaceId, pluginInfo, context) {
    return {
      surface: new Cloud9Surface(surfaceId, pluginInfo, context),
      registerProps: {
        brightness: true,
        surfaceLayout: LAYOUT,
        pincodeMap: PINCODE_MAP,
        configFields: CONFIG_FIELDS,
        transferVariables: undefined,
        canChangePage: { label: 'Right-side page keys change page' },
        location: null,
      },
    }
  },
}

export default plugin
