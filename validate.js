// Validate the surface layout and manifest against the Companion 5.1 API.
import fs from 'node:fs'
import { validateSurfaceLayout, validateSurfaceManifest } from '@companion-surface/base'
import { buildLayout } from './protocol.js'

const layout = buildLayout()
validateSurfaceLayout(layout)
console.log(`layout ok: ${Object.keys(layout.controls).length} controls`)

const manifest = JSON.parse(
  fs.readFileSync(new URL('./companion/manifest.json', import.meta.url), 'utf8'),
)
validateSurfaceManifest(manifest, true)
console.log('manifest ok:', manifest.id, 'api', manifest.runtime.apiVersion,
            'usbIds', JSON.stringify(manifest.usbIds))
