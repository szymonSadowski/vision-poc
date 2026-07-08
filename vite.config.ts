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
});
