// Standalone protocol test (no Companion required).
//
//   npm install
//   node test_standalone.js
//
// Opens the board with node-hid, paints a couple of labels and prints button
// presses for 20 seconds. Use this to prove the JS path before installing the
// surface module into Companion.

import { createRequire } from 'node:module'
import {
  VID,
  PID,
  buttonPacket,
  lcdPacket,
  ledPacket,
  toUsbReport,
  normalizeInput,
  controlIdForBit,
  CMD,
} from './protocol.js'

const require = createRequire(import.meta.url)
const hid = require('node-hid')
const { HID } = hid

const info = hid.devices().find((d) => d.vendorId === VID && d.productId === PID)
if (!info) {
  console.error('Cloud9 button board not found')
  process.exit(1)
}

console.log('opening', info.path, info.product)
const dev = new HID(info.path)

const write = (payload) => dev.write(toUsbReport(payload))

write(lcdPacket({ enable: true, brightness: 200, page: 1 }))
write(ledPacket({ index: 3, enable: true }))
write(buttonPacket({
  index: 0,
  lines: ['HELLO', 'FROM', 'NODE', 'HID'],
  textOn: 0xffff,
  textOff: 0xffff,
  bkgOn: 0x097b,
  bkgOff: 0x097b,
  borderOn: 0x001f,
  borderOff: 0x001f,
}))

let last = 0
dev.on('data', (data) => {
  const d = normalizeInput(data)
  if (!d.length || d[0] !== CMD.EVENT || d.length < 8) return
  const map = d.readUInt32LE(4) >>> 0
  const changed = (map ^ last) >>> 0
  last = map
  for (let bit = 0; bit < 32; bit++) {
    if (!(changed & (1 << bit))) continue
    const id = controlIdForBit(bit)
    if (id) console.log(map & (1 << bit) ? 'down' : 'up  ', id, 'bit', bit)
  }
})

dev.on('error', (e) => console.error('hid error', e))
console.log('listening for 20s; press keys...')
setTimeout(() => {
  dev.close()
  process.exit(0)
}, 20000)
