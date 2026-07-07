# Vision Impairment Simulation POC — Requirements

Source: `requirements/20260703_Vision-Simulator-v2-briefing.pdf` (ZEISS Meditec "RE-VEMP" agency briefing). This document extracts and narrows only the **video/image rendering requirements** needed to prove out real-time vision-impairment simulation in the browser. It deliberately excludes the full VEMP platform's business, treatment-comparison, branding and localization scope — see [Out of Scope](#out-of-scope).

## 1. Purpose & Scope

Build a POC that renders real-time, perceptually realistic simulations of common vision impairments (cataract and refractive errors) on a live webcam feed in the browser, with user-adjustable severity. The POC exists to prove the rendering techniques are technically achievable and visually convincing — not to build a product.

### In Scope
- Real-time video manipulation for: myopia, hyperopia, astigmatism, presbyopia, cataract (6 symptoms below).
- Live webcam input, processed and rendered in-browser.
- Interactive controls: diopter sliders, severity toggles, symptom on/off, before/after comparison.
- Visual realism bar defined in [Section 6](#6-visual-realism-requirements).

### Out of Scope
- IOL/treatment comparison business logic (monofocal, multifocal, EDoF, toric lenses) and post-surgical "expected outcome" narratives.
- B2C/B2B2C platform architecture, consultation flows, clinic/doctor tooling.
- Branding, ZEISS design system, de-branding/white-label configuration.
- Localization/translation workflows, market-specific legal/regulatory review.
- Analytics/tracking, agency deliverables, timeline, budget.
- Physical tools (e.g. the discontinued IOL Vision Simulator Cube).
- Offline/batch video file processing as a primary mode (sample media files are fallback/test inputs only, see [Section 7](#7-technical--non-functional-requirements)).

## 2. Conditions & Definitions

| Condition | Definition |
|---|---|
| Myopia | Blurred distance vision with clearer near vision; light focuses in front of the retina. |
| Hyperopia | Difficulty with near vision, reading strain and visual fatigue; light focuses behind the retina. |
| Astigmatism | Distorted or blurred vision at different distances due to irregular focusing (cornea shaped like a rugby ball rather than a sphere, so light focuses on multiple points instead of one). |
| Presbyopia | Age-related loss of near focusing ability, affecting reading and close-up tasks. |
| Cataract | Progressive clouding of the natural lens, leading to blur, glare, reduced contrast, yellowing, and night-driving difficulties. |

## 3. Functional Requirements — Refractive Errors

| Parameter | Required range | Interaction expectation |
|---|---|---|
| Myopia | 0 to -10.00 D | Selectable in 0.25 D increments, real-time visual update |
| Hyperopia | 0 to +7.00 D | Selectable in 0.25 D increments, real-time visual update |
| Astigmatism | 0 to 6.00 D | Selectable in 0.25 D increments, real-time visual update |
| Presbyopia | No diopter table in source briefing | Simulated via a near-focus/reading-distance parameter (not diopter-driven); real-time visual update |

**Rendering guidance:**
- Myopia/hyperopia: symmetric blur, radius scaling with diopter magnitude. Hyperopia should read as lighter/less severe blur than an equivalent-magnitude myopia value (near-task strain, not heavy defocus) — treat as an approximation since true accommodation-dependent blur needs depth data unavailable from a 2D feed.
- Astigmatism: directional/elliptical blur (independent major/minor axis radii plus an axis-angle control), not a symmetric blur — see severity mapping below for the target look at each diopter band.
- Presbyopia: blur radius driven by a user-set simulated reading-distance/near-focus parameter rather than scene depth; explicitly an approximation, not scene-aware.

### Astigmatism severity → visual effect reference (from briefing backup)

| Diopter (CYL) | Severity | What you see |
|---|---|---|
| 0.00 D | Perfect | Crisp, clear vision at all distances; light converges perfectly on the retina without distortion. |
| 0.25–0.75 D | Mild/Subclinical | Mostly clear; no visual blur noticed by day; at night, bright points of light may show very slight smearing or "halos." |
| 1.00–2.00 D | Moderate | Noticeable blur or slight "shadows" around text/objects; streetlights at night appear visibly stretched or smudged. |
| 2.50–4.00 D | High | Significant distortion; straight lines (doorways, powerlines) appear wavy or tilted; text looks smeared and highly shadowed. |
| 4.25–6.00 D | Severe | Extreme distortion; world appears heavily blurred and stretched, as if viewed through rippled glass or water. |

Reference test: without astigmatism, point light sources (streetlamps, headlights) render as sharp pinpricks; with astigmatism they become streaked/elongated (vertically or horizontally) or surrounded by starbursts. Use this as the visual target for the astigmatism shader, especially in night-driving scenes.

## 4. Functional Requirements — Cataract

Six symptoms, each **independently toggleable**, each with **adjustable severity** (mild/moderate/severe, or a continuous equivalent), and **combinable** where medically meaningful (users should be able to stack multiple active symptoms at once).

| Symptom | Requirement |
|---|---|
| Blurred vision | Variable severity slider. |
| Glare sensitivity | Distinct daytime and nighttime variants. |
| Halos around lights | Around streetlights, vehicle lights, and possibly indoor lighting. |
| Reduced contrast sensitivity | Fog simulation and low-light environment variants. |
| Yellowing of vision | Visible color shift, comparable before/after. |
| Night-time driving difficulties | Realistic night driving scene simulation. |

**Note:** "Night-time driving difficulties" is a composite demo scenario (glare + halos + contrast loss + blur applied together with night-tuned parameters against a driving scene), not a standalone rendering primitive — treat it as a preset that chains the other symptom passes, and use `media/car.mp4` as the reference test scene.

## 5. Interaction Requirements

- Before/After slider.
- Split-screen comparison.
- Independent on/off toggle per symptom.
- Severity controls (mild/moderate/severe presets, or continuous).
- Diopter adjustment sliders (0.25 D increments) for myopia, hyperopia, astigmatism.
- All controls update the rendered feed in real time — no "apply" step or reload.

## 6. Visual Realism Requirements

The simulation must be **perceptually realistic rather than merely applying generic blur effects**. Specifically it should prioritize:

- Clinically-informed optical rendering (e.g. astigmatism blur is directional/elongated along an axis, not a uniform symmetric blur).
- Realistic blur behavior appropriate to each condition.
- Authentic halo morphology — halos should visually resemble real halos around actual bright light sources in the scene, not a flat static glow overlay.
- Visible contrast sensitivity changes (compressed dynamic range / washed-out appearance), not simple darkening.
- Dynamic lighting adaptation — glare/halo effects must respond to actual bright regions detected in the live feed in real time, not be baked-in or static.
- High-resolution, artifact-free output (no visible pipeline pixelation/banding beyond the intended effect).

## 7. Technical / Non-Functional Requirements

- **Rendering:** JavaScript/TypeScript in-browser, WebGL2 fragment shaders as the primary rendering approach (real-time multi-pass effects: blur, bloom/glare, color grading). Canvas2D-only fallback is a stretch goal, not guaranteed — WebGL2 support varies across browsers/OS (older Safari, some mobile browsers) and should be flagged as a compatibility risk, not silently unsupported.
- **Input:** Live webcam feed via `getUserMedia` as the primary input.
- **Fallback input:** When webcam access is denied or unavailable, fall back to the bundled sample assets — `media/car.mp4` (driving/night scenario) and `media/dims.apnews.jpg` (static scene) — so the POC remains demonstrable without camera access.
- **Performance target:** ≥30 fps sustained while any combination of symptoms is active; no perceptible stutter to a viewer. Flag as a risk on low-end/integrated-GPU or mobile devices once multiple shader passes (e.g. directional blur + bloom + LUT) are stacked — a reduced-resolution or reduced-pass fallback mode may be needed.
- **Browser support target:** latest Chrome, Edge, Firefox (WebGL2). Safari/mobile WebGL2 support noted as a known risk.

## 8. Test / Demo Scenarios

From the briefing's real-world scenario list, mapped to which symptoms they best exercise for POC demo/testing purposes:

| Scenario | Sub-cases | Symptoms best exercised |
|---|---|---|
| Reading | Book / menu / smartphone | Blur (myopia/presbyopia), contrast loss |
| Driving | Day / night / rain | Glare, halos, night-driving composite — use `media/car.mp4` |
| Office | Computer work, meetings | Screen glare, contrast loss |
| Home | TV, cooking, family interactions | Blur, contrast loss |
| Outdoor | Walking, shopping, sports | Daytime glare, contrast sensitivity (bright/high dynamic range) |

`media/car.mp4` directly covers the driving/night scenario and should be the primary fallback asset for validating glare, halo, and the night-driving composite. `media/dims.apnews.jpg` can validate static-scene effects (blur, yellowing, contrast) where a still frame is easier to inspect than live video.

## 9. Acceptance Criteria

- Astigmatism slider at 4.00 D visibly elongates a point light source along the configured axis, in real time, on both live webcam and `car.mp4`.
- Myopia/hyperopia sliders produce visibly increasing blur as diopter magnitude increases, updating live as the slider moves.
- Each of the 6 cataract symptoms can be toggled on/off independently and combined with at least one other symptom simultaneously, without requiring a fixed activation order.
- Glare/halo effects visibly key off actual bright regions in the live feed (e.g. moving a bright light source in frame moves the glare/halo with it) rather than rendering as a static overlay.
- Yellowing toggle produces a visible, consistent warm color shift, comparable via before/after slider or split-screen.
- Contrast-sensitivity toggle visibly compresses dynamic range / reduces contrast rather than simply darkening the image.
- Night-driving preset renders glare + halos + contrast loss + blur together against `car.mp4` at the target frame rate.
- Sustained ≥30 fps with at least two symptoms active simultaneously on a mid-range laptop GPU.
- Webcam-denied state falls back to `car.mp4`/`dims.apnews.jpg` without breaking the UI.

## 10. Assumptions & Open Risks

- **No depth sensing:** presbyopia's near-focus blur and any depth-aware fog effect cannot use true scene depth from a single 2D webcam feed; both are parameter-driven approximations, not scene-aware. This should be communicated as a POC limitation, not hidden.
- **No clinical calibration:** the mapping from diopter value to blur radius/pixel parameters is a POC design choice for visual plausibility, not a clinically validated model — avoid over-claiming literal clinical accuracy despite the briefing's "clinically accurate" language; aim for perceptual plausibility.
- **Severity model:** recommend a single internal continuous intensity value (0–1) per effect, with mild/moderate/severe exposed in the UI as presets mapped to fixed intensity values (e.g. 0.33 / 0.66 / 1.0). This decision should be fixed early since both diopter sliders and severity presets need to drive the same underlying shader uniforms.
- **Performance risk:** stacking multiple multi-pass effects (directional blur + bloom/glare + LUT color grading) simultaneously may not sustain target frame rate on low-end or mobile devices; a reduced-resolution or reduced-pass mode may be needed as a fallback, out of scope for initial POC unless time allows.
- **Browser/WebGL2 compatibility:** support varies, particularly on Safari and some mobile browsers; POC should target evergreen desktop Chrome/Edge/Firefox first and treat broader compatibility as a stretch goal.
- **Webcam permissions:** denial or unavailability must not block the demo — fallback media assets are a functional requirement, not optional polish.
- **Repo hygiene:** `media/car.mp4` is a large binary asset; consider Git LFS or excluding it from future commits (noted here for awareness, not a functional requirement of the POC itself).
