// The baseline: play the material faster or slower (the old-school 音MAD
// pitch change). Pitch and length move together and the formants move with
// the pitch, so it can neither keep the length nor the voice's character —
// it's here to compare the other methods against.

import type { ShiftRequest } from "./shift";

export function resampleShift(request: ShiftRequest): Float32Array {
  const rate = 2 ** (request.shift / 12);
  const x = request.input;
  const out = new Float32Array(Math.floor(x.length / rate));
  for (let n = 0; n < out.length; n++) out[n] = cubicAt(x, n * rate);
  return out;
}

/** x at a fractional position, by cubic Hermite interpolation. */
export function cubicAt(x: Float32Array, position: number): number {
  const i = Math.floor(position);
  const f = position - i;
  const at = (k: number) => (k >= 0 && k < x.length ? x[k] : 0);
  const y0 = at(i - 1);
  const y1 = at(i);
  const y2 = at(i + 1);
  const y3 = at(i + 2);
  const c1 = 0.5 * (y2 - y0);
  const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
  return ((c3 * f + c2) * f + c1) * f + y1;
}
