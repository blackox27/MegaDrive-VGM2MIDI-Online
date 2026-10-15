/* Real waveform display helpers. Gain affects the drawing only, never audio. */
(function (root) {
  "use strict";
  function trace(
    data,
    sampleRate = 44100,
    pitch = 440,
    previousPeak = 0,
    count = 512,
    output = null,
  ) {
    count = Number.isInteger(count) ? Math.max(2, Math.min(4096, count)) : 512;
    const values =
      output instanceof Float32Array && output.length === count
        ? output
        : new Float32Array(count);
    const flat = () => ({
      values: values.fill(0),
      peak: 0,
      rms: 0,
      envelope: 0,
      span: 0,
      trigger: 0,
    });
    if (!data || data.length < 2) return flat();
    const sample = (i) => (Number.isFinite(data[i]) ? data[i] : 0);
    let mean = 0;
    for (let i = 0; i < data.length; i++) mean += sample(i);
    mean /= data.length;
    let peak = 0,
      power = 0;
    for (let i = 0; i < data.length; i++) {
      const v = sample(i) - mean;
      peak = Math.max(peak, Math.abs(v));
      power += v * v;
    }
    const rms = Math.sqrt(power / data.length);
    if (peak < 1e-5 || rms < 1e-6) return flat();
    const envelope = Math.max(
      peak,
      Number.isFinite(previousPeak) ? previousPeak * 0.86 : 0,
    );
    const frequency = Number.isFinite(pitch) && pitch > 0 ? pitch : 440;
    const rate =
      Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 44100;
    const span = Math.min(
      data.length - 1,
      Math.max(1, Math.round((rate / frequency) * 2)),
    );
    let trigger = 0;
    for (let i = 1; i < data.length - span; i++)
      if (sample(i - 1) <= mean && sample(i) > mean) {
        trigger = i;
        break;
      }

    for (let i = 0; i < count; i++) {
      const at = trigger + (i / (count - 1)) * span,
        j = Math.floor(at),
        fraction = at - j;
      values[i] = Math.max(
        -1,
        Math.min(
          1,
          (sample(j) * (1 - fraction) +
            sample(Math.min(j + 1, data.length - 1)) * fraction -
            mean) /
            envelope,
        ),
      );
    }
    return { values, peak, rms, envelope, span, trigger };
  }
  const api = { trace };
  root.ScopeDSP = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
