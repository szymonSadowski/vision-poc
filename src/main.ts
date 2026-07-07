import "./style.css";
import { defaultState, Store } from "./state";
import { Pipeline } from "./gl/pipeline";
import { MediaSourceManager } from "./input/media-source";
import { buildControls } from "./ui/controls";

const canvas = document.getElementById("gl-canvas") as HTMLCanvasElement;
const panel = document.getElementById("panel") as HTMLElement;
const fpsEl = document.getElementById("fps") as HTMLElement;
const statusEl = document.getElementById("source-status") as HTMLElement;
const stageWrap = document.getElementById("stage-wrap") as HTMLElement;
const splitHandle = document.getElementById("split-handle") as HTMLElement;
const labelBefore = document.getElementById("label-before") as HTMLElement;
const labelAfter = document.getElementById("label-after") as HTMLElement;

let pipeline: Pipeline;
try {
  pipeline = new Pipeline(canvas);
} catch (err) {
  document.body.innerHTML = `<div style="padding:2rem;font-family:sans-serif;color:#fff;background:#111;height:100vh">
    <h1>WebGL2 is not available</h1>
    <p>${(err as Error).message}</p>
    <p>This POC requires WebGL2 (evergreen Chrome, Edge, or Firefox). Safari and some mobile
    browsers have limited/no support — see requirements §7 for the documented compatibility risk.</p>
  </div>`;
  throw err;
}

const store = new Store(defaultState());
const media = new MediaSourceManager((status) => {
  statusEl.textContent = status;
});

function updateSplitUI() {
  const mode = store.state.viewMode;
  splitHandle.hidden = mode !== "before-after";
  labelBefore.hidden = mode === "normal";
  labelAfter.hidden = mode === "normal";
  if (mode === "before-after") {
    splitHandle.style.left = `${store.state.splitPos * 100}%`;
  } else if (mode === "split") {
    splitHandle.style.left = "50%";
  }
}

store.subscribe(updateSplitUI);
updateSplitUI();

buildControls(panel, store, media);

// --- before/after divider drag -------------------------------------------
let dragging = false;
function posFromEvent(clientX: number): number {
  const rect = stageWrap.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
}
splitHandle.addEventListener("pointerdown", (e) => {
  dragging = true;
  splitHandle.setPointerCapture(e.pointerId);
});
splitHandle.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const pos = posFromEvent(e.clientX);
  store.update((s) => (s.splitPos = pos));
  splitHandle.style.left = `${pos * 100}%`;
});
splitHandle.addEventListener("pointerup", (e) => {
  dragging = false;
  splitHandle.releasePointerCapture(e.pointerId);
});
stageWrap.addEventListener("click", (e) => {
  if (store.state.viewMode !== "before-after") return;
  const pos = posFromEvent(e.clientX);
  store.update((s) => (s.splitPos = pos));
  splitHandle.style.left = `${pos * 100}%`;
});

// --- render loop with fps counter -----------------------------------------
let frameCount = 0;
let lastFpsUpdate = performance.now();

function frame(now: number) {
  requestAnimationFrame(frame);

  if (media.isReady()) {
    pipeline.render(media.getHandle().element, store.state);
  }

  frameCount++;
  if (now - lastFpsUpdate >= 500) {
    const fps = (frameCount * 1000) / (now - lastFpsUpdate);
    fpsEl.textContent = `${fps.toFixed(0)} fps`;
    frameCount = 0;
    lastFpsUpdate = now;
  }
}

media.init().then((resolved) => {
  store.update((s) => (s.source = resolved));
  requestAnimationFrame(frame);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) media.resumeIfNeeded();
});
