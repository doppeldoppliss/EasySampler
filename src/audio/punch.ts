// How hard the kick hits through the rest (design.md 51): under 150 Hz, the loudest 10 ms against the mean over
// each 3 s, the middle of those over the song. A kick that stands out of the bass reads high; a bass held under it,
// or a kick rounded off, reads low. Finished songs measured 6.6 (a very loud master), 8.5 and 10.7 dB.

export function lowPunchDb(left: Float32Array, right: Float32Array, sampleRate: number): number {
  const blk = Math.max(1, Math.round(0.01 * sampleRate));
  const per = 300;
  // Two one-pole low-passes at 150 Hz.
  const k = Math.exp((-2 * Math.PI * 150) / sampleRate);
  let a = 0;
  let b = 0;
  const powers: number[] = [];
  for (let i = 0; i + blk <= left.length; i += blk) {
    let s = 0;
    for (let j = i; j < i + blk; j++) {
      a = a * k + ((left[j] + right[j]) / 2) * (1 - k);
      b = b * k + a * (1 - k);
      s += b * b;
    }
    powers.push(s / blk);
  }
  const crests: number[] = [];
  for (let i = 0; i + per <= powers.length; i += per) {
    let sum = 0;
    let most = 0;
    for (let j = i; j < i + per; j++) {
      sum += powers[j];
      most = Math.max(most, powers[j]);
    }
    const mean = sum / per;
    if (mean > 1e-9) crests.push(10 * Math.log10(most / mean));
  }
  if (!crests.length) return NaN;
  crests.sort((x, y) => x - y);
  return crests[Math.floor(crests.length / 2)];
}
