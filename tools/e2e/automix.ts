// The automatic mixing's regression test (design.md 53): a made-up song of four parts — a melody on the built-in
// piano, a bass and chords, a drum track with kicks — mixed by まとめて自動ミックス twice in the real page. The second
// run must leave what the first one set (the volumes, the automatic effects, the master), as a run done again by the
// user does; and what comes out must sit where the steps aim. Once each run brought the drums a dB further down
// (design.md 51), and nothing caught it.
//
//   npm run e2e            (after the smoke test; a dev server on a free port, headless Chrome)

import { chromium } from "playwright-core";
import { createServer } from "vite";

const fail = (why: string): never => {
  console.error(`✗ ${why}`);
  process.exit(1);
};

const server = await createServer({ server: { port: 0, strictPort: false }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) fail("the dev server did not start");

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => errors.push(`page: ${e.message}`));
  // (tsx keeps function names with a helper the page does not have.)
  await page.addInitScript("window.__name = (f) => f;");
  await page.goto(url!);
  await page.waitForFunction(() => !!(window as unknown as { __easysampler?: unknown }).__easysampler, null, { timeout: 30_000 });
  // (The built-in piano is made after the page comes up: until its cut is offered, its tracks render silent.)
  await page.waitForFunction(
    () => {
      const { rollPanel: r } = (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler;
      const first = r.project.tracks[0];
      return !!first?.instrument && (r.options as { id: string }[]).some((o) => o.id === first.instrument);
    },
    null,
    { timeout: 60_000 },
  );

  // The song: 16 bars at 120.
  const made = await page.evaluate(() => {
    const { rollPanel: r } = (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler;
    const first = r.project.tracks[0];
    let id = 1;
    const note = (pitch: number, start: number, length: number, velocity = 0.85) => ({ id: id++, pitch, start, length, velocity });
    const bars = 16;
    const melody = Array.from({ length: bars * 4 }, (_, i) => note([72, 74, 76, 79, 77, 76, 74, 72][i % 8], i, 0.9));
    const roots = [48, 45, 41, 43];
    const bass = Array.from({ length: bars * 4 }, (_, i) => note(roots[Math.floor(i / 4) % 4] - 12, i, 0.9));
    const chords = Array.from({ length: bars }, (_, b) => [0, 4, 7].map((k) => note(roots[b % 4] + 12 + k, b * 4, 4, 0.7))).flat();
    const drums = Array.from({ length: bars * 4 }, (_, i) => [note(36, i, 0.25), ...(i % 2 ? [note(38, i, 0.25)] : []), note(42, i + 0.5, 0.25, 0.6)]).flat();
    const track = (name: string, extra: Record<string, unknown>) => ({ ...structuredClone(first), id: `e2e-${name}`, name, mute: false, solo: false, gain: 1, pan: 0, role: null, main: false, emphasis: false, volumeAuto: [], panAuto: [], ...extra });
    r.project.bpm = 120;
    r.project.tempos = [];
    r.project.masterAuto = [];
    r.project.tracks = [
      track("メロディ", { notes: melody }),
      track("ベース", { notes: bass, instrument: "backing" }),
      track("和音", { notes: chords }),
      track("ドラム", { notes: drums, kind: "drum", instrument: null }),
    ];
    r.selected = 0;
    r.renderTracks();
    r.renderMix();
    r.reload();
    return r.roles();
  });
  if (made.join() !== "lead,bass,chords,drum") fail(`the parts were not read as meant: ${made.join(", ")}`);
  console.log(`✓ a song of four parts: ${made.join(", ")}`);

  const run = () =>
    page.evaluate(async () => {
      const { rollPanel: r } = (window as unknown as { __easysampler: { rollPanel: any } }).__easysampler;
      r.info.textContent = "";
      r.onAutoMixAll();
      const t0 = performance.now();
      while (!/^まとめて自動ミックスをしました/.test(r.info.textContent) && performance.now() - t0 < 300_000) await new Promise((resolve) => setTimeout(resolve, 250));
      const p = r.snapshot();
      return {
        said: r.info.textContent as string,
        seconds: (performance.now() - t0) / 1000,
        tracks: p.tracks.map((t: any) => ({ name: t.name, db: 20 * Math.log10(t.gain), pan: t.pan, eq: t.fx.eq.on ? `${t.fx.eq.lowCutHz}/${t.fx.eq.midDb}@${Math.round(t.fx.eq.midHz)}` : "off", duck: t.fx.duck.on ? t.fx.duck.depthDb : 0, room: t.fx.reverb.on ? t.fx.reverb.mix : 0, attack: t.fx.transient.on ? t.fx.transient.attackDb : 0 })),
        master: { eq: `${p.masterFx.eq.lowDb}@${p.masterFx.eq.lowHz}/${p.masterFx.eq.midDb}@${Math.round(p.masterFx.eq.midHz)}/${p.masterFx.eq.highDb}`, width: p.masterFx.width.on ? p.masterFx.width.side : 1, clip: p.masterFx.clip.on ? p.masterFx.clip.thresholdDb : null },
      };
    });
  const once = await run();
  if (!/^まとめて自動ミックスをしました/.test(once.said)) fail(`the automatic mixing did not finish: "${once.said.slice(0, 200)}"`);
  console.log(`✓ まとめて自動ミックス ran (${once.seconds.toFixed(0)} s)`);

  // Where it aims: the melody the reference, the bass as loud as it, the chords under it; the kick's punch reached;
  // the song under full scale; nothing buried.
  const step = (label: string) => new RegExp(`\\d+\\. ${label}: ([^]*?)(?= \\d+\\. |$)`).exec(once.said)?.[1] ?? "";
  const diagnosis = step("診断");
  const whole = /曲全体 ([−-]?[\d.]+) LUFS・ピーク ([−-]?[\d.]+) dBTP、気になる点 (\d+) 件/.exec(diagnosis);
  if (!whole) fail(`no diagnosis at the end: "${diagnosis}"`);
  const [lufs, peak, points] = [Number(whole![1]), Number(whole![2]), Number(whole![3])];
  if (!(lufs > -30 && lufs < -5)) fail(`the song's loudness is off: ${lufs} LUFS`);
  if (!(peak <= 0)) fail(`the song goes over full scale: ${peak} dBTP`);
  const punch = step("キックの立ち上がり");
  const reached = /→ ([\d.]+) dB、目安 8 dB 以上/.exec(punch) ?? /立ち上がりは ([\d.]+) dB で、目安/.exec(punch);
  if (!reached || Number(reached[1]) < 8) fail(`the kick's punch was not brought to 8 dB: "${punch}"`);
  const rows = await page.evaluate(() => {
    const d = [...document.querySelectorAll("details")].find((x) => /^診断の結果/.test(x.querySelector("summary")?.textContent ?? ""));
    return [...(d?.querySelectorAll("tr") ?? [])].slice(1).map((tr) => [...tr.children].map((c) => c.textContent ?? ""));
  });
  const said = await page.evaluate(() => {
    const d = [...document.querySelectorAll("details")].find((x) => /^診断の結果/.test(x.querySelector("summary")?.textContent ?? ""));
    return [...(d?.querySelectorAll("li") ?? [])].map((li) => (li.textContent ?? "").slice(0, 70));
  });
  const lufsOf = (name: string) => Number(rows.find((r) => r[0] === name)?.[2].replace("−", "-").replace(" LUFS", ""));
  const melody = lufsOf("メロディ"), bass = lufsOf("ベース"), chords = lufsOf("和音");
  if (!(Math.abs(bass - melody) < 1)) fail(`the bass is not as loud as the melody: ${bass} against ${melody} LUFS\n  ${rows.map((r) => r.join(" | ")).join("\n  ")}`);
  if (!(chords < melody - 2 && chords > melody - 8)) fail(`the chords are not a little under the melody: ${chords} against ${melody} LUFS`);
  const heard = rows.map((r) => ({ name: r[0], share: Number(/^([\d.]+)%/.exec(r[4])?.[1]) }));
  if (heard.some((h) => !(h.share >= 1.5))) fail(`a track is buried: ${heard.map((h) => `${h.name} ${h.share}%`).join(", ")}`);
  console.log(`✓ it lands where it aims: ${lufs} LUFS, peak ${peak} dBTP, kick ${reached![1]} dB, bass ${(bass - melody).toFixed(1)} and chords ${(chords - melody).toFixed(1)} dB from the melody, heard ${heard.map((h) => `${h.share}%`).join(" / ")}, ${points} point(s)${said.length ? `: ${said.join(" / ")}…` : ""}`);

  // Again: nothing moves.
  const twice = await run();
  const moved: string[] = [];
  type Row = { name: string; db: number; pan: number; eq: string; duck: number; room: number; attack: number };
  (once.tracks as Row[]).forEach((a, i) => {
    const b = (twice.tracks as Row[])[i];
    if (Math.abs(a.db - b.db) > 0.05) moved.push(`${a.name} volume ${a.db.toFixed(2)} → ${b.db.toFixed(2)} dB`);
    for (const k of ["pan", "eq", "duck", "room", "attack"] as const) if (a[k] !== b[k]) moved.push(`${a.name} ${k} ${a[k]} → ${b[k]}`);
  });
  if (once.master.eq !== twice.master.eq) moved.push(`master EQ ${once.master.eq} → ${twice.master.eq}`);
  if (once.master.width !== twice.master.width) moved.push(`width ${once.master.width} → ${twice.master.width}`);
  if (Math.abs((once.master.clip ?? 0) - (twice.master.clip ?? 0)) > 0.25 || (once.master.clip === null) !== (twice.master.clip === null)) moved.push(`rounding ${once.master.clip} → ${twice.master.clip} dBFS`);
  if (moved.length) fail(`a second run changed what the first set:\n  ${moved.join("\n  ")}`);
  console.log("✓ a second run leaves it as it was");

  if (errors.length) fail(`errors were thrown:\n  ${errors.join("\n  ")}`);
  console.log("✓ no errors in the page or the workers");
} finally {
  await browser.close();
  await server.close();
}
