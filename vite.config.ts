import basicSsl from "@vitejs/plugin-basic-ssl";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

/** Gives the service worker's cache a name of this build's own (public/sw.js carries a placeholder). */
function stampServiceWorker(): Plugin {
  return {
    name: "maddaw-stamp-sw",
    apply: "build",
    closeBundle() {
      const file = fileURLToPath(new URL("dist/sw.js", import.meta.url));
      if (!existsSync(file)) return;
      writeFileSync(file, readFileSync(file, "utf8").replace("__BUILD__", Date.now().toString(36)));
    },
  };
}

export default defineConfig(({ mode }) => {
  // `npm run dev:lan` / `vite preview --mode lan`: served over HTTPS on the local
  // network, so an iPad can open it — AudioWorklet only runs in a secure context,
  // and a plain http://192.168.x.x page is not one.
  const lan = mode === "lan";
  return {
    base: "./",
    plugins: [stampServiceWorker(), ...(lan ? [basicSsl()] : [])],
    server: { host: lan ? true : undefined },
    preview: { host: lan ? true : undefined },
    worker: { format: "es" as const },
  };
});
