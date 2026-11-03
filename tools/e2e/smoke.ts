// The end-to-end smoke test (design.md 38): the real page in a real browser —
// it comes up, a song plays and the master meter moves (the AudioWorklet
// started), the render worker measures (the diagnosis finishes), and nothing
// throws anywhere (page, worklet or worker). Unit tests check the parts; this
// checks that they still make sound together: once a release went out silent
// because the worklet would not start, and every unit test passed.
//
//   npm run e2e            (a dev server on a free port, headless Chrome)

import { chromium, type ConsoleMessage } from "playwright-core";
import { createServer } from "vite";

const fail = (why: string): never => {
  console.error(`✗ ${why}`);
  process.exit(1);
};

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) fail("the dev server did not start");

// The installed Chrome (no browser download); sound without a gesture, a fake output device.
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream"] });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  await page.goto(url!);
  await page.waitForFunction(() => !!(window as unknown as { __easysampler?: unknown }).__easysampler, null, { timeout: 30_000 });
  console.log("✓ the page came up");

  // A song: four bars on the built-in piano (the first track), played from the start.
  const started = await page.evaluate(async () => {
    const { rollPanel: r } = (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler;
    const t = r.project.tracks[0];
    t.notes = Array.from({ length: 16 }, (_, i) => ({ id: i + 1, pitch: 60 + (i % 5), start: i, length: 0.9, velocity: 0.9 }));
    t.mute = false;
    t.solo = false;
    r.reload();
    r.toggle();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return { playing: r.playing as boolean, instrument: t.instrument as string | null };
  });
  if (!started.instrument) fail("the first track has no instrument to play");
  if (!started.playing) fail("playback did not start");

  // The master meter: what the worklet reports while it sounds.
  const meter = await page.evaluate(() => {
    const text = [...document.querySelectorAll("span")].map((e) => e.textContent ?? "").find((t) => /ピーク .* dB・/.test(t)) ?? "";
    const m = text.match(/ピーク ([−-]?[\d.]+|−∞) dB/);
    return m ? (m[1] === "−∞" ? -Infinity : Number(m[1].replace("−", "-"))) : null;
  });
  // (No reading at all: the worklet never reported — it did not start, so nothing sounds.)
  if (meter === null) fail("no sound: the master meter never got a reading while playing (the AudioWorklet did not start)");
  if (!(meter! > -60)) fail(`no sound: the master peak reads ${meter} dB while playing (the AudioWorklet may not have started)`);
  console.log(`✓ it plays: the master peak reads ${meter} dB`);
  await page.evaluate(() => (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler.rollPanel.toggle());

  // The render worker: the diagnosis renders the track and the song off the page and comes back.
  const diagnosis = await page.evaluate(async () => {
    const { rollPanel: r } = (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler;
    r.info.textContent = "";
    r.onDiagnose();
    const t0 = performance.now();
    while (!/診断しました|ありません/.test(r.info.textContent) && performance.now() - t0 < 60_000) await new Promise((resolve) => setTimeout(resolve, 250));
    return r.info.textContent as string;
  });
  const lufs = diagnosis.match(/曲全体 ([−-]?[\d.]+) LUFS/);
  if (!lufs) fail(`the diagnosis did not finish: "${diagnosis}"`);
  if (!(Number(lufs![1]) > -60)) fail(`the render worker rendered silence: ${diagnosis}`);
  console.log(`✓ the render worker measures: ${diagnosis.slice(0, 60)}`);

  if (errors.length) fail(`errors were thrown:\n  ${errors.join("\n  ")}`);
  console.log("✓ no errors in the page, the worklet or the workers");
} finally {
  await browser.close();
  await server.close();
}
