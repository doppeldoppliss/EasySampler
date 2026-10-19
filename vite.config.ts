import basicSsl from "@vitejs/plugin-basic-ssl";
import { defineConfig } from "vite";

// The same isolation headers the published site will send (public/_headers),
// so SharedArrayBuffer and the WASM worklets behave in dev as they will live.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig(({ mode }) => {
  // `npm run dev:lan`: served over HTTPS on the local network, so an iPad can
  // open it — AudioWorklet only runs in a secure context, and a plain
  // http://192.168.x.x page is not one.
  const lan = mode === "lan";
  return {
    base: "./",
    plugins: lan ? [basicSsl()] : [],
    server: { headers: isolation, host: lan ? true : undefined },
    preview: { headers: isolation },
    worker: { format: "es" as const },
  };
});
