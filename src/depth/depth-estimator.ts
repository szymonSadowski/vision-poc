// wasm-only subpath (not the default export) — see vite.config.ts's
// resolve.conditions for why, avoids bundling onnxruntime-web's wasm binary.
import * as ort from "onnxruntime-web/wasm";

// MiDaS v2.1 small (MIT licensed, julienkay/sentis-MiDaS on Hugging Face).
// Vendored locally under media/models/ (served same-origin, publicDir is
// "media" — see vite.config.ts) rather than fetched from Hugging Face's
// CDN at runtime: that CDN response has permissive CORS headers, but in
// practice ad-blockers/tracking-protection/corporate networks block the
// `xet-bridge` storage subdomain outright (observed: Firefox "CORS request
// did not succeed" with a null status, i.e. the request never completed),
// which is a much bigger reliability risk for a demo than the ~66MB repo
// size cost. Same "commit the large binary" precedent as media/car.mp4
// (see the .gitignore comment) — Git LFS is a fine follow-up, not required.
const MODEL_URL = "/models/midas_v21_small_256.onnx";
const MODEL_INPUT_SIZE = 256;
// Between-inference delay — the model runs its own loop decoupled from the
// render loop's rAF cadence, so this just caps how often we re-sample
// rather than targeting a specific fps.
const STEP_DELAY_MS = 60;

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web ?? "1.27.0"}/dist/`;
// Single-threaded WASM avoids the COOP/COEP cross-origin-isolation headers
// that SharedArrayBuffer-based threading would require from the dev/build
// server and from the CDN-hosted model/wasm responses.
ort.env.wasm.numThreads = 1;
// Runs the WASM runtime in a dedicated Worker instead of the main thread.
// Without this, session.run() blocks the calling (main) thread for its
// entire ~200ms+ duration even though it's awaited — that's synchronous
// WASM compute, not I/O, so `await` alone does not yield to rAF. That
// blocking was stalling the render loop every ~250ms regardless of the
// "decoupled" scheduling loop below.
ort.env.wasm.proxy = true;

export type DepthListener = (depth: Uint8Array, width: number, height: number) => void;

/**
 * Runs MiDaS-small monocular depth estimation against the current frame
 * source on its own async loop, fully decoupled from the WebGL render
 * loop. Output is per-frame min-max normalized "nearness" (0 = farthest
 * pixel in frame, 255 = nearest) — MiDaS produces relative inverse depth,
 * not metric depth, so there is no stable absolute scale to normalize
 * against across frames.
 */
export class DepthEstimator {
  private session: ort.InferenceSession | null = null;
  private loading = false;
  private loadFailed = false;
  private running = false;
  private inFlight = false;
  private source: CanvasImageSource | null = null;
  private scratch: HTMLCanvasElement;
  private scratchCtx: CanvasRenderingContext2D;
  private listeners = new Set<DepthListener>();
  private _available = false;

  constructor() {
    this.scratch = document.createElement("canvas");
    this.scratch.width = MODEL_INPUT_SIZE;
    this.scratch.height = MODEL_INPUT_SIZE;
    const ctx = this.scratch.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("2D canvas context unavailable for depth preprocessing");
    this.scratchCtx = ctx;
  }

  /** True once at least one inference has completed successfully. */
  get available(): boolean {
    return this._available;
  }

  /** True if the model failed to load (e.g. no WASM support) — permanent. */
  get failed(): boolean {
    return this.loadFailed;
  }

  onDepth(fn: DepthListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Cheap per-frame call — just stashes a reference. The loop below decides
   * when to actually sample/downscale/infer, independent of render cadence. */
  setSource(source: CanvasImageSource) {
    this.source = source;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop() {
    this.running = false;
  }

  private async loop() {
    while (this.running) {
      await this.step();
      await new Promise((resolve) => setTimeout(resolve, STEP_DELAY_MS));
    }
  }

  private async step() {
    if (this.inFlight || !this.source || this.loadFailed) return;
    if (!this.session) {
      if (!this.loading) await this.load();
      return;
    }

    this.inFlight = true;
    try {
      const input = this.preprocess(this.source);
      const results = await this.session.run({ input_image: input });
      const output = results["output_depth"];
      const depth = this.postprocess(output.data as Float32Array);
      this._available = true;
      for (const fn of this.listeners) fn(depth, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    } catch (err) {
      console.error("Depth inference failed", err);
    } finally {
      this.inFlight = false;
    }
  }

  private async load() {
    this.loading = true;
    try {
      this.session = await ort.InferenceSession.create(MODEL_URL, {
        executionProviders: ["wasm"],
      });
    } catch (err) {
      console.error("Failed to load depth model — depth-aware effects disabled", err);
      this.loadFailed = true;
    } finally {
      this.loading = false;
    }
  }

  // Model expects `input_image`: float32 NCHW [1,3,256,256], values in
  // [0,1] (normalization is baked into the model weights — no additional
  // mean/std subtraction needed), RGB channel order.
  private preprocess(source: CanvasImageSource): ort.Tensor {
    const ctx = this.scratchCtx;
    ctx.drawImage(source, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
    const { data } = ctx.getImageData(0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);

    const plane = MODEL_INPUT_SIZE * MODEL_INPUT_SIZE;
    const chw = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      const o = i * 4;
      chw[i] = data[o] / 255;
      chw[plane + i] = data[o + 1] / 255;
      chw[plane * 2 + i] = data[o + 2] / 255;
    }
    return new ort.Tensor("float32", chw, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]);
  }

  private postprocess(raw: Float32Array): Uint8Array {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < raw.length; i++) {
      const v = raw[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = max - min || 1;
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      out[i] = Math.round(((raw[i] - min) / range) * 255);
    }
    return out;
  }
}
