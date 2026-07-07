import { defineConfig } from "vite";

// media/ is served as the public dir so car.mp4 / dims.apnews.jpg
// are available at /car.mp4 and /dims.apnews.jpg without duplicating
// the large binary into the source tree.
export default defineConfig({
  publicDir: "media",
  server: {
    host: true,
  },
});
