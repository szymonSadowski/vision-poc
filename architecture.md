# Architecture

Vision Impairment Simulator — a browser POC that renders real-time simulations
of refractive errors (myopia, hyperopia, astigmatism, presbyopia) and cataract
symptoms (blur, glare, halos, contrast loss, yellowing) on a live webcam feed,
using a multi-pass WebGL2 shader pipeline. See `requirements.md` for the
product spec this implements.

## Tech stack

- **TypeScript**, strict mode, no framework — plain DOM APIs for UI, no
  virtual DOM, no build-time templating.
- **Vite** for dev server + build (`vite.config.ts` sets `publicDir: "media"`
  so `car.mp4` / `dims.apnews.jpg` are served at `/car.mp4` / `/dims.apnews.jpg`
  without duplicating the binaries into `src`).
- **WebGL2** (raw API, no three.js or similar) for the render pipeline —
  chosen for full control over the multi-pass compositing needed for
  bloom/halo effects at real-time framerates.
- No test framework, no CSS framework, no state library — the whole app is
  ~1000 lines across a handful of modules.

Package manager is pnpm (`pnpm-lock.yaml`). Scripts: `pnpm dev`, `pnpm build`
(`tsc -b && vite build`), `pnpm preview`.

## Module map

```
index.html              shell: canvas + control panel containers
src/main.ts              wires everything together, owns the render loop
src/state.ts              AppState shape + Store (pub/sub state container)
src/ui/controls.ts        builds the entire control panel from AppState
src/input/media-source.ts webcam/car.mp4/dims.jpg source switching
src/gl/pipeline.ts        the multi-pass WebGL2 render pipeline
src/gl/shaders.ts         all GLSL source, as template strings
src/gl/gl-utils.ts        low-level WebGL helpers (compile/link/texture/FBO)
src/style.css             all styling, plain CSS custom properties
```

There's no framework-level "component" abstraction — `controls.ts` directly
builds and appends DOM nodes, and `pipeline.ts` directly issues WebGL calls.
State flows one way: UI writes to `Store` → `Store` notifies subscribers →
`main.ts`'s render loop reads `store.state` each frame and passes it into
`Pipeline.render()`, which derives shader uniforms from it. There's no
diffing — every frame is redrawn from scratch from current state.

## Data flow

```
MediaSourceManager ──element (video/img)──┐
                                           ▼
                                      Pipeline.render(source, state)
                                           ▲
Store (AppState) ◄──user input── controls.ts
```

1. `main.ts` creates a `Pipeline` (owns the WebGL2 context + canvas) and a
   `MediaSourceManager` (owns the `<video>`/`<img>` elements).
2. `buildControls()` renders the entire right-hand panel from the current
   `AppState` and wires every slider/checkbox/button to call
   `store.update(mutator)`.
3. A `requestAnimationFrame` loop in `main.ts` calls
   `pipeline.render(media.getHandle().element, store.state)` every frame,
   whenever the current source reports it has a fresh frame ready
   (`media.isReady()`).
4. `Pipeline.render()` uploads that frame as a WebGL texture and runs it
   through the shader passes described below, using `state` to compute
   per-frame uniform values (blur radius, glare intensity, etc.).

There is no debouncing/memoization — sliders update `AppState` synchronously
on `input` events, and the next animation frame just picks up the new values.

## Input sources (`src/input/media-source.ts`)

`MediaSourceManager` owns three `<video>`/`<img>` elements simultaneously
(webcam, `car.mp4`, `dims.apnews.jpg`) and switches which one is "current":

- **Webcam** is the primary input (`getUserMedia`). If permission is denied
  or no camera exists, it falls back to `car.mp4` automatically.
- **`car.mp4`** and **`dims.apnews.jpg`** are static sample assets (served
  from `media/`) used as a fallback and for testing effects against
  consistent footage (e.g. the night-driving preset always switches to
  `car.mp4`).
- All media elements are kept in the DOM (off-screen via `position: fixed;
  left: -9999px`, 1×1px) rather than `display: none` — some browsers throttle
  decode/rAF for `display:none` video, which would stall the texture feed.
- `isReady()` checks `readyState`/`complete` so the render loop skips frames
  before the current source has actual data.

## Render pipeline (`src/gl/pipeline.ts`, `src/gl/shaders.ts`)

Each frame runs through up to five WebGL2 passes, chained via offscreen
framebuffers (`RenderTarget` in `gl-utils.ts`), before drawing to the canvas.
All passes render a single oversized fullscreen triangle (not a quad) to
avoid a diagonal seam.

```
video/image frame
   │  (texImage2D upload, UNPACK_FLIP_Y_WEBGL=true)
   ▼
┌─────────────────────┐
│ 1. Refraction blur   │  elliptical multi-tap blur — myopia/hyperopia/
│    (full res)        │  presbyopia/cataract-blur combine into an isotropic
│                       │  radius; astigmatism adds anisotropic stretch
└─────────┬─────────────┘
          │ rtRefract
┌─────────▼─────────────┐        ┌──────────────────────┐
│ 2. Bright threshold    │        │  raw (unprocessed)    │
│    (half res)          │        │  texture, kept for    │
└─────────┬───────────────┘        │  before/after + split │
          │ rtBright                └───────────┬───────────┘
┌─────────▼─────────────┐                        │
│ 3. Narrow blur (2 pass │                        │
│    separable gaussian) │                        │
└─────────┬───────────────┘                        │
          │ rtNarrow                               │
┌─────────▼─────────────┐                          │
│ 4. Wide blur (2 pass,  │                          │
│    larger radius)      │                          │
└─────────┬───────────────┘                          │
          │ rtWide                                   │
          ▼                                          ▼
┌───────────────────────────────────────────────────────┐
│ 5. Composite: base + (wide*glare) + (wide-narrow)*halo  │
│    → contrast/fog → yellowing → view-mode resolve       │
│    (normal / before-after slider / split screen)        │
└───────────────────────────────────────────────────────┘
                          │
                          ▼
                     canvas (on screen)
```

Pass details:

1. **Refraction blur** (`FRAG_REFRACTION_BLUR`) — a 16-tap spiral kernel
   approximating a gaussian disk, with independent X/Y radii and a rotation
   angle so it can stretch into an ellipse (astigmatism) or stay circular
   (myopia/hyperopia/presbyopia/cataract blur, which are summed into one
   isotropic radius before this pass — see the `K_*_PX` constants and
   `isoPx` calculation in `pipeline.ts`).
2. **Threshold** (`FRAG_THRESHOLD`) — extracts bright regions (luminance
   above a threshold that tightens as glare/halo intensity increases) from
   the *unblurred* frame, at half resolution, feeding the bloom chain.
3–4. **Narrow/wide blur** (`FRAG_BLUR_1D`) — a reused separable 9-tap
   gaussian, run twice (horizontal then vertical) at two different radii.
   The wide pass is a further blur of the narrow result, not a second
   independent blur of the threshold output — this is what makes
   `wide - narrow` in the composite produce a clean halo *ring* rather than
   a blob when subtracted from the narrow "core" bloom.
5. **Composite** (`FRAG_COMPOSITE`) — combines the refraction-blurred base
   with glare (wide bloom tinted day/night-white) and halos (the wide−narrow
   difference-of-gaussians ring), then applies contrast compression (lift
   toward mid-gray) and/or fog (whitish veil) or low-light
   (desaturate+darken) depending on variant, then lens yellowing (multiply
   by a warm tint), then resolves `viewMode`:
   - `normal` — processed frame only.
   - `before-after` — raw left of `uSplitPos`, processed right (draggable
     divider, `main.ts` pointer handlers).
   - `split` — raw and processed side by side, each re-mapped into its own
     half of the UV space.

All severity/toggle state (`AppState` in `state.ts`) maps to shader uniforms
every frame in `Pipeline.render()` — there's no shader recompilation or
branching program selection; every effect is always "on" in the sense that
its uniform is just driven to 0 when disabled.

Resolution handling: `Pipeline.resize()` caps the working resolution to
1280px on the long edge (perf headroom for the multi-pass chain on
integrated GPUs) and allocates two resolution tiers of render targets — full
res for the refraction pass, half res for the bloom chain (bloom doesn't
need full detail and halving cuts blur-pass cost ~4x).

## State (`src/state.ts`)

`AppState` is one flat-ish object: refractive error magnitudes (myopia,
hyperopia, astigmatism + axis, presbyopia), six `CataractSymptom` entries
(`{ enabled, intensity }`, two of which also carry a `variant`), view mode,
split position, and current source. `Store` is a minimal pub/sub wrapper —
`update(mutator)` mutates `state` in place then synchronously notifies every
subscriber. There's no time-travel, undo, or serialization; it exists purely
to let `controls.ts` and `main.ts` react to the same mutable object without
prop-drilling.

`Store.applyNightDrivingPreset()` is the one piece of cross-cutting state
logic: it chains five cataract symptoms to night-tuned intensities in one
update, and the click handler in `controls.ts` additionally switches the
media source to `car.mp4` (source switching is intentionally kept out of the
`Store` — it's async and has side effects, so the caller decides whether to
trigger it).

## UI (`src/ui/controls.ts`)

Pure DOM construction, no templating. `buildControls()` tears down and
rebuilds the entire panel (`panel.innerHTML = ""` then rebuild) — cheap
enough at this UI size, and used deliberately by the night-driving preset
handler to reflect its chained toggle changes without hand-updating five
separate rows. Individual sliders/checkboxes otherwise update their own DOM
node directly on input rather than going through a full rebuild (e.g.
`cataractRow`'s slider updates `valueEl.textContent` inline).

## Known constraints (see `requirements.md` for full detail)

- Diopter→blur-radius mapping is a hand-tuned visual approximation, not a
  clinical model.
- Presbyopia and fog have no scene depth, so blur/veil is uniform across the
  frame rather than distance-aware.
- Requires WebGL2 — `main.ts` shows a fallback error message if unavailable
  (Safari/mobile have limited support, a known risk per requirements §7).
