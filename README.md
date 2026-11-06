# Cloud9 Button Board — Bitfocus Companion surface module

Companion **5.1+** surface integration for the Cloud9 / Symphony 24-button
board (USB `2C82:012D`, model 0301).

Repository: <https://github.com/RoseOO/companion-cloud9-buttonboard>
Releases: <https://github.com/RoseOO/companion-cloud9-buttonboard/releases>

The 24 LCD keys are presented as a **12 × 2** Companion grid. The 8 side keys
are not part of the page layout; they are configured as page hotkeys or
Companion targets in the surface settings.

Companion pushes the button **text** and **background colour**; the module
wraps the text to the board's 4 lines × 8 characters and sends the button
packet. Input reports are translated back to Companion `keyDown`/`keyUp`
events. The board's corner page indicator is updated from the Companion page
number, and brightness maps to the LCD backlight.

> The board is text-only. Companion's button images are not used (there is no
> bitmap command); the button name/text and colour are what appear on the keys.

## Files

| file | purpose |
|------|---------|
| `main.js` | SurfacePlugin / SurfaceInstance implementation |
| `protocol.js` | packet builders, colour conversion, index mapping, text wrap |
| `companion/manifest.json` | surface module manifest (`usbIds`, runtime API 1.4.0) |
| `build-config.cjs` | packaging config (includes `node-hid` prebuilds) |
| `test_standalone.js` | opens the board with node-hid and paints a test label |
| `validate.js` | validates the layout and manifest against `@companion-surface/base` |
| `LICENSE` | MIT |

## Quick test without Companion

```powershell
cd companion-cloud9-buttonboard
npm install
node validate.js
node test_standalone.js
```

`test_standalone.js` puts `HELLO / FROM / NODE / HID` on key 1 and prints the
Companion control id for each key you press for 20 seconds.

## Installing into Companion 5.1

### Option A — dev folder (recommended while developing)

1. In `%APPDATA%\companion\config.json` set:
   ```json
   "enable_developer": true,
   "dev_modules_path": "C:\\Users\\Rose\\src\\cloud9\\companion-dev"
   ```
2. Create `companion-dev` and put (or junction/symlink) this folder inside it:
   ```
   companion-dev\cloud9-buttonboard\
     companion\manifest.json
     main.js
     protocol.js
     node_modules\...
     package.json
   ```
3. Restart Companion.
4. Open **Surfaces → Add Surface Integration → Cloud9 Button Board**.

### Option B — installed surface folder

Copy the whole module folder (including `node_modules`) to:

```
%APPDATA%\companion\surfaces\cloud9-buttonboard
```

then restart Companion and add the surface integration. Companion's surface
folder README warns it is for installed modules; this is fine for a local
prototype, but use the module build/packaging tooling for distribution.

### Option C — release package (offline install)

Download `cloud9-buttonboard-<version>.tgz` from the
[Releases page](https://github.com/RoseOO/companion-cloud9-buttonboard/releases).
In Companion open the **Modules** page, click **Import module package**, and
select the `.tgz`. Then add **Cloud9 Button Board** on the Surfaces page.

The package is a tar.gz archive built with Companion's official surface
packager and includes the `node-hid` prebuilt binaries for Windows, macOS and
Linux (x64/arm64). No `npm install` or internet access is needed on the target
machine.

## Building the release package

```powershell
npm install
npm run build
```

This writes `cloud9-buttonboard-<version>.tgz` in the repository root. The
version comes from `package.json`; the module id and entrypoint come from
`companion/manifest.json`. `build-config.cjs` tells the packager to include the
`node-hid` prebuilds.

To sanity-check the manifest and layout before packaging:

```powershell
npx companion-surface-check
npm run validate
```

## Mapping

The surface layout is **12 × 2**: rows 0–1, columns 0–11, which matches the
physical two 6×2 blocks side by side. The main keys are numbered
`1/0/0` … `1/1/11`.

```
row 0, columns 0-5   = left block, top row
row 0, columns 6-11  = right block, top row
row 1, columns 0-5   = left block, bottom row
row 1, columns 6-11  = right block, bottom row
```

The input-report bit order has the two middle physical rows crossed relative to
this render/label order. `controlIdForBit()` swaps the input rows; the output
mapping (`boxForControlId()`) stays direct.

Companion needs its page grid at 12×2 for this surface. The
**prompt to expand the grid when attaching a new surface** only *grows* the
current bounds: from the default 8×4 grid its “Resize grid to fit” action
produces **12×4**, not 12×2. Set the grid to 12×2 once manually. If the grid is
already 12×2 the surface fits and no prompt appears; the prompt will not shrink
rows back to 2.

The 8 side keys are **not** in the layout. They are handled by the module and
configured in the surface settings:

- left column: page hotkeys, or a target Companion button
- right top toggle: page hotkey, or a target Companion button
- right second/third: page up/down (or target overrides)
- right bottom menu: home page (or target override)

Targets use the form `page/row/column` (e.g. `1/0/3`) with **0-based
row/column**. A side key holds the target while pressed and releases it on
release, matching a physical button:
`POST /api/location/<page>/<row>/<column>/down` on press and
`POST /api/location/<page>/<row>/<column>/up` on release. Enable the HTTP API in
Companion; a token is optional. If the target button is empty, Companion
returns 204 and nothing happens.

## Rendering notes

- `stylePresets.default = { text: true, colors: 'hex' }`
- Text is wrapped to 4 lines × 8 characters; longer text is truncated.
- Unicode punctuation is normalised to displayable characters: em/en dash →
  `-`, curly quotes → `'`/`"`, ellipsis → `...`, bullet → `*`, arrows → `->`
  etc. Unsupported glyphs become `?`.
- Text alignment is configurable with the **Text alignment** setting
  (left/centre/right) and per-button overrides such as
  `0/4:center,1/5:right`.
- **Unassigned buttons** show Companion's `page/row/column` (e.g. `1/0/0`)
  in grey on black. Disable **Show page/row/column on unused buttons** to leave
  them blank instead; the change applies immediately.
- **Pressed buttons** get a yellow border locally while held.
- **Companion error state**: Companion's surface API does not expose the
  connection/button error flag, but it draws a red error triangle into the
  rendered button image. The module requests a 32×32 bitmap and samples the
  top-right area for that red icon, then mirrors it as a red border.
- On a page change all 24 keys are reset to their page placeholders first, so
  stale labels from the previous page do not persist.
- `setBrightness(percent)` → `0x53` LCD packet, brightness `0..255`.
- `blank()` clears all 24 keys but **keeps the backlight on** (Companion calls
  it after `setBrightness`, so turning the light off here would blank the keys).
- Side-key settings:
  - **left column** (top→bottom) = four page hotkeys
    (`Left 1 -> page` … `Left 4 -> page`; `0` disables a key), each with an
    optional `Left N target` override
  - **right top toggle** = optional page (`Right top toggle -> page`, `0` = none)
    and/or `Right top toggle target`
  - **right second/third** = page up/down, with optional `Page Up target` /
    `Page Down target` overrides
  - **right bottom menu** = `Home page`, with an optional `Home target` override
  These require the surface setting **“Right-side page keys change page”** to
  be enabled; the surface config stores it as `canChangePage`.
- Target buttons are held and released via Companion's local HTTP API:
  `POST /api/location/<page>/<row>/<column>/down` and `/up` (0-based
  row/column). The HTTP API must be enabled; a token is optional. If the target
  is empty, Companion returns 204 and no action runs.
- Page hotkeys work by stepping with Companion's `changePage` API; set them to
  pages that actually exist. They are best-effort for non-contiguous pages.
- The status LED (index 3) is on by default; see **LEDs** below.

## LEDs

The board has four green LEDs. They are exposed as surface **output variables**
(`led0`–`led3`), so Companion expressions can drive them individually from the
surface settings:

| variable | LED |
|----------|-----|
| `led0` | left handset |
| `led1` | right handset |
| `led2` | speaker |
| `led3` | status |

Set an expression to `1`, `true` or `on` to light that LED; `0`, `false`,
`off`, an empty expression or `$NA` turns it off. Values are updated live.

`led3` is on by default as a status light until its expression produces a
value. The LEDs are on/off only — the firmware accepts an intensity value but
does not visibly dim them.

## Surface lock / PIN code

The surface registers a Companion **single-page pincode map**, so Companion's
"lock surface" feature works without any custom lock handling in the module.
When locked, Companion blanks the board and draws its own keypad on the **left
bank** only:

- **1–5** on the top row, columns 0–4 (`0/0` … `0/4`)
- **6–0** on the bottom row, columns 0–4 (`1/0` … `1/4`)
- the PIN entry / `Lockout` display at the bottom-right of the bank (`1/5`)
- `LOCKED` on the top-right key of the bank (`0/5`)

Digit keys use a dark background (default `#141a20`) rather than Companion's
white lock-screen colour. Change it with the **Lock / PIN screen background**
surface setting.

Press the matching keys to enter the PIN; Companion submits it automatically
once the expected number of digits is entered. The module does not need to know
the PIN.

While locked, side-key targets and page changes are disabled so they cannot
bypass the lock. The display is text-only, so the entry display shows
`*` characters rather than Companion's "Lockout" graphic.

## Packaging for distribution

`npm pack` does not include `node_modules`, and `node-hid` ships a native
prebuild (`node_modules/node-hid/prebuilds/HID-win32-x64/node-napi-v4.node`).
Use Companion's module build/packaging workflow (or ship the folder with
`node_modules`) so the native prebuild is included in the offline bundle.

## Known limitations

- **Textless / icon-only buttons are not distinguishable.** Companion's
  surface API does not expose a button's text when the button only has an
  icon, nor an “assigned” flag. A textless, colourless control — including
  Companion's page up/down/number buttons — is identical to an empty button,
  so the board keeps showing the `page/row/column` placeholder (unless
  **Show page/row/column on unused buttons** is disabled, in which case they
  stay blank). Adding text or a non-black colour makes it appear immediately.
- **No DB reads.** The module deliberately does not read Companion's local
  database; button types and the startup page are not obtained that way.
- **Grid prompt only grows.** Companion's “Resize grid to fit” expands the
  current bounds; from the default 8×4 grid it produces 12×4, not 12×2. Set the
  grid to 12×2 once manually.
- **Text colour is not exposed by the public API.** The surface draw props
  contain only the background `color`, text, and rendered image; Companion's
  HTTP API has only style *setters* (no getter for button style). The board
  therefore chooses black or white text from the background brightness instead
  of mirroring a per-button text colour.
- **Error border is inferred.** Companion does not expose the connection/button
  error flag to surface modules; the red border is derived from the rendered
  red error icon in the 32×32 bitmap. If no icon is rendered, no red border.
- **Text-only display.** No arbitrary images. An ASCII approximation of icons
  was tried and removed because it was unreadable and affected empty buttons.
- The 8 side keys have no LCDs and are configured in the surface settings;
  they are not part of the 12×2 page layout.
- Page targets only press controls that exist on the current page grid; an
  empty target returns 204 and does nothing.
- The 4 board LEDs are driven by Companion expressions on `led0`–`led3`.
