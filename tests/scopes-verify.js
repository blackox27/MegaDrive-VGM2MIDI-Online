"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  { trace } = require("../src/audio/scopes.js");
const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.stack });
    console.error(name, e.message);
  }
}
const wave = (
  frequency,
  amplitude = 0.002,
  offset = 0,
  phase = 0.63,
  rate = 44100,
) =>
  Float32Array.from(
    { length: 4096 },
    (_, i) =>
      offset +
      amplitude * Math.sin((i / rate) * frequency * 2 * Math.PI + phase),
  );
const spread = (v) => Math.max(...v) - Math.min(...v);
test("Sinal baixo de 440 Hz ocupa a altura do monitor", () => {
  const t = trace(wave(440), 44100, 440);
  assert.ok(spread(t.values) > 1.95);
  assert.ok(t.peak < 0.003);
});
test("Nota grave de 55 Hz mostra dois ciclos completos", () => {
  const t = trace(wave(55), 44100, 55);
  assert.equal(t.span, 1604);
  let rises = 0;
  for (let i = 1; i < t.values.length; i++)
    if (t.values[i - 1] < 0 && t.values[i] >= 0) rises++;
  assert.ok(rises >= 2);
  assert.ok(spread(t.values) > 1.9);
});
test("Taxa de 48 kHz preserva a janela temporal", () => {
  const t = trace(wave(55, 0.002, 0, 0.63, 48000), 48000, 55);
  assert.equal(t.span, 1745);
  assert.ok(spread(t.values) > 1.9);
});
test("Escala do gráfico não altera os samples originais", () => {
  const data = wave(440),
    copy = data.slice();
  trace(data);
  assert.deepEqual(data, copy);
});
test("Silêncio permanece plano mesmo depois de uma nota forte", () => {
  const t = trace(new Float32Array(4096), 44100, 440, 0.9);
  assert.equal(spread(t.values), 0);
  assert.equal(t.rms, 0);
  assert.equal(t.envelope, 0);
});
test("Nenhum áudio conectado permanece plano", () =>
  assert.equal(spread(trace(null).values), 0));
test("Offset DC constante permanece plano", () =>
  assert.equal(spread(trace(new Float32Array(4096).fill(0.4)).values), 0));
test("Offset DC em um sinal é removido apenas da visualização", () => {
  const t = trace(wave(440, 0.002, 0.3));
  assert.ok(spread(t.values) > 1.9);
  assert.ok(t.peak < 0.003);
});
test("Aumento de amplitude não satura o desenho", () => {
  const t = trace(wave(440, 0.8), 44100, 440, 0.002);
  assert.ok(Math.max(...t.values) <= 1);
  assert.ok(spread(t.values) > 1.9);
});
test("Medidor conserva RMS baixo sem usar o ganho visual", () => {
  const t = trace(wave(440));
  assert.ok(t.rms > 0.0013 && t.rms < 0.0015);
  assert.ok(20 * Math.log10(t.rms) < -55);
});
test("Samples não finitos não contaminam as coordenadas", () => {
  const a = wave(440);
  a[0] = NaN;
  a[1] = Infinity;
  const t = trace(a);
  assert.ok([...t.values].every(Number.isFinite));
});
test("Entrada curta e afinação extrema não saem do buffer", () => {
  for (const f of [0, NaN, 1, 20000]) {
    const t = trace(Float32Array.of(-0.1, 0.1, 0.1, -0.1), 44100, f);
    assert.ok([...t.values].every(Number.isFinite));
    assert.ok(t.trigger + t.span < 4);
  }
});
fs.writeFileSync(
  "tests/results/scopes-results.json",
  JSON.stringify(
    {
      environment: "Node; sinais sintéticos; sem captura de áudio de navegador",
      total: results.length,
      passed: results.filter((t) => t.status === "PASS").length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    total: results.length,
    passed: results.filter((t) => t.status === "PASS").length,
  }),
);
if (results.some((t) => t.status === "FAIL")) process.exitCode = 1;
