import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** Every source file the AudioWorklet loads (worklet.ts and what it imports, in turn). */
function workletSources(): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (file: string) => {
    if (out.has(file)) return;
    const text = readFileSync(file, "utf8");
    out.set(file, text);
    for (const m of text.matchAll(/^import\s+(?!type\b)[^;]*?from\s+"(\.[^"]+)"/gm)) {
      const base = resolve(dirname(file), m[1]);
      const next = [`${base}.ts`, `${base}/index.ts`].find((f) => existsSync(f));
      if (next) visit(next);
    }
  };
  visit(resolve(__dirname, "worklet.ts"));
  return out;
}

describe("the AudioWorklet's code", () => {
  // An AudioWorkletGlobalScope is not a window or a worker: these are not there, and calling one stops the engine
  // (no sound at all). Comments are left out of the check.
  it("uses nothing an AudioWorklet does not have", () => {
    const missing = ["structuredClone", "setTimeout", "setInterval", "requestAnimationFrame", "window.", "document.", "fetch(", "performance.now"];
    for (const [file, text] of workletSources()) {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      for (const name of missing) expect(code.includes(name), `${file} uses ${name}`).toBe(false);
    }
  });
});
