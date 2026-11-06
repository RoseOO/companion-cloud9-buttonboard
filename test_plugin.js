// Exercise the plugin's Companion-facing code path without Companion.
//
//   node test_plugin.js
//
// Opens the real board, paints a Companion-style button, and prints the
// keyDown/keyUp calls a real SurfaceContext would receive.
import { createRequire } from 'node:module'
import plugin from './main.js'

const require = createRequire(import.meta.url)
const { devices } = require('node-hid')

const dev = devices().find((d) => d.vendorId === 0x2c82 && d.productId === 0x012d)
if (!dev) {
  console.error('board not found')
  process.exit(1)
}

const info = plugin.checkSupportsHidDevice(dev)
if (!info) {
  console.error('checkSupportsHidDevice rejected the board')
  process.exit(1)
}
console.log('discovered:', info.surfaceId, info.description)

const context = {
  isLocked: false,
  keyDownById: (id) => console.log('keyDown', id),
  keyUpById: (id) => console.log('keyUp  ', id),
  disconnect: (e) => console.log('disconnect', e?.message ?? e),
}

const { surface, registerProps } = await plugin.openSurface(info.surfaceId, info.pluginInfo, context)
console.log('layout controls:', Object.keys(registerProps.surfaceLayout.controls).length)

await surface.init()
await surface.setBrightness(90)
await surface.draw(new AbortController().signal, {
  controlId: '0/1',
  text: 'AAPL\nBUY 100\nC2C',
  color: '#0a5a2a',
  pageNumber: 1,
})
console.log('drew 0/1; press keys for 15s...')

setTimeout(async () => {
  await surface.close()
  process.exit(0)
}, 15000)
