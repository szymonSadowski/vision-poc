import { defineConfig } from "vite";

// media/ is served as the public dir so car.mp4 / dims.apnews.jpg
// are available at /car.mp4 and /dims.apnews.jpg without duplicating
// the large binary into the source tree.
export default defineConfig({
  publicDir: "media",
  server: {
    host: true,
  },
  // onnxruntime-web's default export condition bundles its wasm binary
  // (13-26MB) straight into the build via a static asset reference, even
  // though we set env.wasm.wasmPaths to fetch it from a CDN at runtime.
  // This custom condition (its own documented escape hatch) picks the
  // "extern-wasm" build instead, which has no bundled binary at all.
  resolve: {
    conditions: ["onnxruntime-web-use-extern-wasm"],
  },
  // onnxruntime-web's proxy worker (ort.env.wasm.proxy = true, see
  // depth-estimator.ts) loads itself as a Worker via import.meta.url.
  // Without a separate chunk, that resolves to the single bundled app
  // file in production, so the worker re-executes main.ts's top-level
  // `document.getElementById(...)` calls in a scope with no `document`,
  // throwing before ort's worker handshake completes ("no available
  // backend found"). Isolating it into its own chunk keeps that
  // self-import worker-safe.
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("onnxruntime-web")) return "ort";
        },
      },
    },
  },
});
