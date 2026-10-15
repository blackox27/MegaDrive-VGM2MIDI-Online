"use strict";
const fs = require("fs"),
  assert = require("assert/strict"),
  S = require("../src/audio/sf2.js"),
  results = [];
const fontBytes = fs.readFileSync("assets/soundfonts/Mega_16-Bit_FM_SF2.sf2");
let font;
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.stack });
    console.log("FAIL", name, e.message);
  }
}
const param = () => ({
  events: [],
  setValueAtTime(v, t) {
    assert.ok(Number.isFinite(v) && Number.isFinite(t) && t >= 0);
    this.events.push({ v, t });
  },
  linearRampToValueAtTime(v, t) {
    this.setValueAtTime(v, t);
  },
});
const nodes = [];
const ctx = {
  currentTime: 0,
  sampleRate: 44100,
  createBuffer(c, n, rate) {
    const a = new Float32Array(n);
    return {
      length: n,
      duration: n / rate,
      sampleRate: rate,
      getChannelData() {
        return a;
      },
    };
  },
  createBufferSource() {
    const n = {
      playbackRate: param(),
      connect() {},
      disconnect() {},
      start(t, o) {
        assert.ok(t >= 0 && o >= 0 && o < this.buffer.duration);
        this.started = { t, o };
      },
      stop(t) {
        if (t !== undefined) assert.ok(t >= 0);
      },
    };
    nodes.push(n);
    return n;
  },
  createGain() {
    return { gain: param(), connect() {}, disconnect() {} };
  },
  createStereoPanner() {
    return { pan: param(), connect() {}, disconnect() {} };
  },
};
test("SF2 real: 206 presets, 584 samples e 1639 regiões", () => {
  font = S.parse(fontBytes);
  assert.equal(font.name, "Mega 16-Bit FM SF2");
  assert.equal(font.presets.length, 206);
  assert.equal(font.samples.length, 584);
  assert.equal(
    font.presets.reduce((s, p) => s + p.regions.length, 0),
    1639,
  );
});
test("Todos os presets têm regiões dentro dos samples e ranges MIDI", () => {
  for (const p of font.presets) {
    assert.ok(p.regions.length);
    for (const r of p.regions) {
      assert.ok(r.start >= 0 && r.end <= font.pcm.length);
      assert.ok(
        r.keyLo >= 0 && r.keyHi <= 127 && r.velLo >= 0 && r.velHi <= 127,
      );
    }
  }
});
const sampler = new S.Sampler(ctx, null);
test("Seleção automática/manual preserva os bancos reais", () => {
  sampler.font = font;
  const i = font.presets.findIndex((p) => p.bank === 7 && p.program === 81);
  assert.ok(i >= 0);
  assert.equal(sampler.choose(81, false, i).index, i);
  assert.equal(sampler.choose(0, true).bank, 128);
  assert.equal(sampler.choose(61).program, 61);
});
test("AudioBuffer é gerado a partir do PCM16 real da SF2", () => {
  const r = font.presets[0].regions[0],
    buf = sampler.buffer(r),
    v = new DataView(
      fontBytes.buffer,
      fontBytes.byteOffset,
      fontBytes.byteLength,
    );
  assert.equal(buf.length, r.end - r.start);
  assert.equal(buf.sampleRate, r.sample.rate);
  for (const i of [0, Math.floor(buf.length / 2), buf.length - 1])
    assert.equal(
      buf.getChannelData(0)[i],
      v.getInt16(font.pcm.offset + (r.start + i) * 2, true) / 32768,
    );
  assert.strictEqual(sampler.buffer(r), buf);
});
test("Velocidade e tecla escolhem zonas reais", () => {
  const p = font.presets[0],
    r = p.regions[0],
    key = Math.floor((r.keyLo + r.keyHi) / 2),
    vel = Math.floor((r.velLo + r.velHi) / 2);
  assert.ok(sampler.regions(p, key, vel).includes(r));
  assert.equal(sampler.regions(p, 128, 128).length, 0);
});
test("Nota SF2 usa BufferSource, afinação, envelope e controles finitos", () => {
  const p = font.presets[0],
    r = p.regions[0],
    key = Math.floor((r.keyLo + r.keyHi) / 2),
    vel = Math.floor((r.velLo + r.velHi) / 2),
    voices = sampler.play(
      p,
      key,
      vel,
      0,
      0.3,
      [
        { at: 0, pitch: key, pan: 64 },
        { at: 0.1, pitch: key + 1, pan: 127 },
      ],
      {},
    );
  assert.ok(voices.length > 0);
  assert.ok(nodes.at(-1).buffer.length > 0);
  assert.ok(nodes.at(-1).playbackRate.events.length >= 2);
  for (const v of voices) v.stop();
});
test("Loops SF2 têm intervalos válidos e seek fica dentro deles", () => {
  const p = font.presets.find((p) =>
      p.regions.some((r) => r.g[54] & 3 && r.loopEnd > r.loopStart),
    ),
    r = p.regions.find((r) => r.g[54] & 3 && r.loopEnd > r.loopStart),
    key = Math.floor((r.keyLo + r.keyHi) / 2),
    vel = Math.floor((r.velLo + r.velHi) / 2);
  const v = sampler.play(p, key, vel, 0, 0.2, [], {}, 3);
  assert.ok(v.length > 0);
  assert.ok(v.some((v) => v.source.loop));
  for (const n of v) assert.ok(n.source.started.o < n.source.buffer.duration);
});
test("Cache pode ser limitado e samples não ficam duplicados sem limite", () => {
  const small = new S.Sampler(ctx, font);
  small.cacheLimit = 1024;
  small.buffer(font.presets[0].regions[0]);
  assert.ok(small.cacheBytes <= 1024);
});
test("SF2 truncada, assinatura e chunks gigantes são rejeitados", () => {
  assert.throws(() => S.parse(fontBytes.subarray(0, 500)), /truncada/);
  assert.throws(() => S.parse(Buffer.alloc(12)), /SF2/);
  const b = Buffer.alloc(24);
  b.write("RIFF");
  b.writeUInt32LE(16, 4);
  b.write("sfbk", 8);
  b.write("LIST", 12);
  b.writeUInt32LE(0x7fffffff, 16);
  assert.throws(() => S.parse(b), /Chunk/);
});
test("Índices de bags corrompidos retornam erro controlado", () => {
  const b = Buffer.from(fontBytes);
  let pos = b.indexOf(
    Buffer.from("phdr"),
    font.pcm.offset + font.pcm.length * 2,
  );
  assert.equal(b.readUInt32LE(pos + 4), 7866);
  b.writeUInt16LE(65535, pos + 8 + 24);
  assert.throws(
    () => S.parse(b),
    (e) => e instanceof Error && !(e instanceof RangeError),
  );
});
test("Offsets de envelope no preset somam ao padrão do instrumento", () => {
  const b = Buffer.from(fontBytes),
    start = font.pcm.offset + font.pcm.length * 2;
  for (const tag of ["igen", "pgen"]) {
    const pos = b.indexOf(Buffer.from(tag), start),
      end = pos + 8 + b.readUInt32LE(pos + 4);
    for (let p = pos + 8; p < end; p += 4)
      if (b.readUInt16LE(p) === 34) {
        if (tag === "igen") b.writeUInt16LE(60, p);
        else b.writeInt16LE(1200, p + 2);
      }
  }
  const f = S.parse(b),
    r = f.presets.flatMap((p) => p.regions).find((r) => r.g[34] !== undefined);
  assert.equal(r.g[34], -10800);
});
fs.writeFileSync(
  "tests/results/sf2-results.json",
  JSON.stringify(
    {
      total: results.length,
      passed: results.filter((r) => r.status === "PASS").length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  results.filter((r) => r.status === "PASS").length + "/" + results.length,
);
if (results.some((r) => r.status === "FAIL")) process.exitCode = 1;
