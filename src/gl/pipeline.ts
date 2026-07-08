import type { AppState } from "../state";
import { DepthEstimator } from "../depth/depth-estimator";
import {
  createDepthTexture,
  createFullscreenQuad,
  createProgram,
  createRenderTarget,
  createVideoTexture,
  resizeRenderTarget,
  uploadDepthData,
  type RenderTarget,
} from "./gl-utils";
import {
  FRAG_BLUR_1D,
  FRAG_COMPOSITE,
  FRAG_REFRACTION_BLUR,
  FRAG_THRESHOLD,
  VERT_FULLSCREEN,
} from "./shaders";

export type FrameSource = HTMLVideoElement | HTMLImageElement;

// Diopter/parameter -> pixel-radius mapping. Visual-plausibility constants,
// not a clinical model (requirements §10) — tuned by eye against the
// astigmatism severity table and myopia/hyperopia "lighter" note in §3.
const K_MYOPIA_PX = 22; // at -10 D, reference height 720
const K_HYPEROPIA_PX = 11; // hyperopia reads lighter than equivalent myopia
const K_PRESBYOPIA_PX = 9;
const K_CATARACT_BLUR_PX = 16;
const K_ASTIG_MAJOR_PX = 26;
const K_ASTIG_MINOR_PX = 4;
const REFERENCE_HEIGHT = 720;

function bloomTint(variant: "day" | "night"): [number, number, number] {
  return variant === "night" ? [0.85, 0.9, 1.0] : [1.0, 0.96, 0.85];
}

export class Pipeline {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;

  private progRefraction: WebGLProgram;
  private progThreshold: WebGLProgram;
  private progBlur: WebGLProgram;
  private progComposite: WebGLProgram;

  private videoTexture: WebGLTexture;
  private rawTexture: WebGLTexture; // separate copy so before/after has a stable "untouched" frame
  private depthTexture: WebGLTexture;
  private depthEstimator: DepthEstimator;
  private pendingDepth: { data: Uint8Array; width: number; height: number } | null = null;

  private rtRefract!: RenderTarget;
  private rtBright!: RenderTarget;
  private rtTmpA!: RenderTarget;
  private rtNarrow!: RenderTarget;
  private rtTmpB!: RenderTarget;
  private rtWide!: RenderTarget;

  private width = 0;
  private height = 0;
  private halfWidth = 0;
  private halfHeight = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: false });
    if (!gl) throw new Error("WebGL2 is not supported in this browser");
    this.gl = gl;

    // DOM video/image sources are top-row-first, but WebGL texture v=0 is
    // the bottom row — without this every frame uploads upside down.
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    this.vao = createFullscreenQuad(gl);
    this.progRefraction = createProgram(gl, VERT_FULLSCREEN, FRAG_REFRACTION_BLUR);
    this.progThreshold = createProgram(gl, VERT_FULLSCREEN, FRAG_THRESHOLD);
    this.progBlur = createProgram(gl, VERT_FULLSCREEN, FRAG_BLUR_1D);
    this.progComposite = createProgram(gl, VERT_FULLSCREEN, FRAG_COMPOSITE);

    this.videoTexture = createVideoTexture(gl);
    this.rawTexture = createVideoTexture(gl);
    this.depthTexture = createDepthTexture(gl);

    // Depth inference runs on its own async loop, fully decoupled from this
    // render loop's rAF cadence (requirements §7 perf budget is already
    // tight with 5 shader passes) — this pipeline just samples whatever
    // depth frame is latest-available each render() call. Started/stopped
    // from render() based on state.depthEnabled.
    this.depthEstimator = new DepthEstimator();
    this.depthEstimator.onDepth((data, width, height) => {
      this.pendingDepth = { data, width, height };
    });

    this.resize(640, 480);
  }

  /** For UI status display — depth-aware effects fall back to flat
   * approximations (today's behavior) until this is true. */
  depthStatus(): { available: boolean; failed: boolean } {
    return { available: this.depthEstimator.available, failed: this.depthEstimator.failed };
  }

  resize(width: number, height: number) {
    const gl = this.gl;
    // Cap working resolution for perf headroom on integrated GPUs while
    // multiple passes are stacked (requirements §7 performance risk note).
    const maxDim = 1280;
    const scale = Math.min(1, maxDim / Math.max(width, height));
    width = Math.max(2, Math.round(width * scale));
    height = Math.max(2, Math.round(height * scale));

    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.halfWidth = Math.max(1, Math.round(width / 2));
    this.halfHeight = Math.max(1, Math.round(height / 2));

    this.canvas.width = width;
    this.canvas.height = height;

    if (!this.rtRefract) {
      this.rtRefract = createRenderTarget(gl, width, height);
      this.rtBright = createRenderTarget(gl, this.halfWidth, this.halfHeight);
      this.rtTmpA = createRenderTarget(gl, this.halfWidth, this.halfHeight);
      this.rtNarrow = createRenderTarget(gl, this.halfWidth, this.halfHeight);
      this.rtTmpB = createRenderTarget(gl, this.halfWidth, this.halfHeight);
      this.rtWide = createRenderTarget(gl, this.halfWidth, this.halfHeight);
    } else {
      resizeRenderTarget(gl, this.rtRefract, width, height);
      resizeRenderTarget(gl, this.rtBright, this.halfWidth, this.halfHeight);
      resizeRenderTarget(gl, this.rtTmpA, this.halfWidth, this.halfHeight);
      resizeRenderTarget(gl, this.rtNarrow, this.halfWidth, this.halfHeight);
      resizeRenderTarget(gl, this.rtTmpB, this.halfWidth, this.halfHeight);
      resizeRenderTarget(gl, this.rtWide, this.halfWidth, this.halfHeight);
    }
  }

  private uploadFrame(source: FrameSource) {
    const gl = this.gl;
    const w = "videoWidth" in source ? source.videoWidth : source.naturalWidth;
    const h = "videoHeight" in source ? source.videoHeight : source.naturalHeight;
    if (w > 0 && h > 0) this.resize(w, h);

    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.bindTexture(gl.TEXTURE_2D, this.rawTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  }

  private drawFullscreen(target: RenderTarget | null, width: number, height: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  render(source: FrameSource, state: AppState) {
    const gl = this.gl;
    this.uploadFrame(source);

    // ---- depth: feed the decoupled inference loop, pull latest result ----
    this.depthEstimator.setSource(source);
    if (state.depthEnabled) this.depthEstimator.start();
    else this.depthEstimator.stop();

    if (this.pendingDepth) {
      const { data, width, height } = this.pendingDepth;
      uploadDepthData(gl, this.depthTexture, data, width, height);
      this.pendingDepth = null;
    }
    const depthAvailable = state.depthEnabled && this.depthEstimator.available ? 1 : 0;

    const heightScale = this.height / REFERENCE_HEIGHT;

    // ---- derive refraction blur uniforms -------------------------------
    const cataractBlurAmt = state.cataractBlur.enabled ? state.cataractBlur.intensity : 0;
    // Myopia/hyperopia/presbyopia are excluded from the flat isotropic sum —
    // each is applied per-pixel in-shader via depth instead (myopia scales
    // with farness — light focuses in front of the retina, so distant
    // objects blur more; hyperopia/presbyopia scale with nearness — near
    // objects blur more), falling back to a flat full-frame contribution
    // when depth isn't available. Cataract blur and astigmatism stay flat:
    // lens clouding and irregular corneal focusing aren't depth-dependent.
    const isoPx = cataractBlurAmt * K_CATARACT_BLUR_PX;
    const myopiaPx = (state.myopia / 10) * K_MYOPIA_PX * heightScale;
    const hyperopiaPx = (state.hyperopia / 7) * K_HYPEROPIA_PX * heightScale;
    const presbyopiaPx = state.presbyopia * K_PRESBYOPIA_PX * heightScale;

    const astigT = state.astigmatism / 6;
    const radiusX = (isoPx + astigT * K_ASTIG_MAJOR_PX) * heightScale;
    const radiusY = (isoPx + astigT * K_ASTIG_MINOR_PX) * heightScale;
    const angle = (state.astigmatismAxis * Math.PI) / 180;

    gl.useProgram(this.progRefraction);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.uniform1i(gl.getUniformLocation(this.progRefraction, "uSource"), 0);
    gl.uniform1i(gl.getUniformLocation(this.progRefraction, "uDepth"), 1);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uDepthAvailable"), depthAvailable);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uMyopiaPx"), myopiaPx);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uHyperopiaPx"), hyperopiaPx);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uPresbyopiaPx"), presbyopiaPx);
    gl.uniform2f(
      gl.getUniformLocation(this.progRefraction, "uTexelSize"),
      1 / this.width,
      1 / this.height,
    );
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uRadiusX"), radiusX);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uRadiusY"), radiusY);
    gl.uniform1f(gl.getUniformLocation(this.progRefraction, "uAngle"), angle);
    this.drawFullscreen(this.rtRefract, this.width, this.height);

    // ---- bright threshold (glare/halo source) --------------------------
    const glareOn = state.cataractGlare.enabled;
    const haloOn = state.cataractHalos.enabled;
    const glareIntensity = glareOn ? state.cataractGlare.intensity : 0;
    const haloIntensity = haloOn ? state.cataractHalos.intensity : 0;
    const isNight = state.cataractGlare.variant === "night";
    const combinedBloomDrive = Math.max(glareIntensity, haloIntensity);

    const threshold = Math.max(0.15, 0.8 - combinedBloomDrive * 0.35 - (isNight ? 0.15 : 0));
    const softness = 0.25;

    gl.useProgram(this.progThreshold);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTexture);
    gl.uniform1i(gl.getUniformLocation(this.progThreshold, "uSource"), 0);
    gl.uniform1f(gl.getUniformLocation(this.progThreshold, "uThreshold"), threshold);
    gl.uniform1f(gl.getUniformLocation(this.progThreshold, "uSoftness"), softness);
    this.drawFullscreen(this.rtBright, this.halfWidth, this.halfHeight);

    // ---- narrow blur (bloom core) ---------------------------------------
    const narrowRadius = 1.4;
    this.blurPass(this.rtBright, this.rtTmpA, [1 / this.halfWidth, 0], narrowRadius);
    this.blurPass(this.rtTmpA, this.rtNarrow, [0, 1 / this.halfHeight], narrowRadius);

    // ---- wide blur (progressive: blurs the narrow result further, giving
    // a halo ring when narrow is subtracted from wide in composite) -------
    const wideRadius = combinedBloomDrive > 0 ? 2.0 + combinedBloomDrive * (isNight ? 10 : 7) : 0;
    this.blurPass(this.rtNarrow, this.rtTmpB, [1 / this.halfWidth, 0], wideRadius);
    this.blurPass(this.rtTmpB, this.rtWide, [0, 1 / this.halfHeight], wideRadius);

    // ---- composite --------------------------------------------------------
    const contrastOn = state.cataractContrast.enabled;
    const contrastIntensity = contrastOn ? state.cataractContrast.intensity : 0;
    const isFog = state.cataractContrast.variant === "fog";

    const glareTint = bloomTint(state.cataractGlare.variant);
    const haloTint = bloomTint(state.cataractGlare.variant);

    gl.useProgram(this.progComposite);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.rtRefract.texture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rawTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.rtNarrow.texture);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.rtWide.texture);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);

    const p = this.progComposite;
    gl.uniform1i(gl.getUniformLocation(p, "uBase"), 0);
    gl.uniform1i(gl.getUniformLocation(p, "uRaw"), 1);
    gl.uniform1i(gl.getUniformLocation(p, "uBloomNarrow"), 2);
    gl.uniform1i(gl.getUniformLocation(p, "uBloomWide"), 3);
    gl.uniform1i(gl.getUniformLocation(p, "uDepth"), 4);
    gl.uniform1f(gl.getUniformLocation(p, "uDepthAvailable"), depthAvailable);
    gl.uniform1f(gl.getUniformLocation(p, "uDepthPreview"), state.depthPreview ? 1 : 0);

    gl.uniform1f(gl.getUniformLocation(p, "uGlareIntensity"), glareIntensity * 0.9);
    gl.uniform3f(gl.getUniformLocation(p, "uGlareTint"), ...glareTint);
    gl.uniform1f(gl.getUniformLocation(p, "uHaloIntensity"), haloIntensity);
    gl.uniform3f(gl.getUniformLocation(p, "uHaloTint"), ...haloTint);

    gl.uniform1f(gl.getUniformLocation(p, "uContrastIntensity"), contrastIntensity);
    gl.uniform1f(gl.getUniformLocation(p, "uFogAmount"), contrastOn && isFog ? contrastIntensity : 0);
    gl.uniform1f(
      gl.getUniformLocation(p, "uLowLightAmount"),
      contrastOn && !isFog ? contrastIntensity : 0,
    );

    gl.uniform1f(
      gl.getUniformLocation(p, "uYellowIntensity"),
      state.cataractYellowing.enabled ? state.cataractYellowing.intensity : 0,
    );

    const viewModeIndex = state.viewMode === "before-after" ? 1 : state.viewMode === "split" ? 2 : 0;
    gl.uniform1i(gl.getUniformLocation(p, "uViewMode"), viewModeIndex);
    gl.uniform1f(gl.getUniformLocation(p, "uSplitPos"), state.splitPos);

    this.drawFullscreen(null, this.width, this.height);
  }

  private blurPass(src: RenderTarget, dst: RenderTarget, direction: [number, number], radius: number) {
    const gl = this.gl;
    gl.useProgram(this.progBlur);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.texture);
    gl.uniform1i(gl.getUniformLocation(this.progBlur, "uSource"), 0);
    gl.uniform2f(gl.getUniformLocation(this.progBlur, "uDirection"), direction[0], direction[1]);
    gl.uniform1f(gl.getUniformLocation(this.progBlur, "uRadius"), radius);
    this.drawFullscreen(dst, dst.width, dst.height);
  }
}
