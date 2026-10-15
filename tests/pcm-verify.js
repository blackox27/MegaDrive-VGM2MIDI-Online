"use strict";
const fs = require("fs"),
  assert = require("assert/strict"),
  C = require("../src/core/vgm.js");
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
const le = (n) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
function vgm(cmd) {
  const b = Buffer.alloc(256 + cmd.length);
  b.write("Vgm ");
  b.writeUInt32LE(b.length - 4, 4);
  b.writeUInt32LE(0x171, 8);
  b.writeUInt32LE(256 - 0x34, 0x34);
  b.writeUInt32LE(7670454, 0x2c);
  b.set(cmd, 256);
  return b;
}
const block = (data, type = 0) => [
    0x67,
    0x66,
    type,
    ...le(data.length),
    ...data,
  ],
  wait = (n) => [0x61, n & 255, n >> 8];
const sine = (freq, dur = 0.4, rate = 11025) =>
  Array.from({ length: Math.round(rate * dur) }, (_, i) =>
    Math.round(128 + 96 * Math.sin((i * 2 * Math.PI * freq) / rate)),
  );
const enable = [0x52, 0x2b, 0x80, 0x53, 0xb6, 0xc0],
  setup = (rate = 11025) => [
    0x90,
    0,
    2,
    0,
    0x2a,
    0x91,
    0,
    0,
    1,
    0,
    0x92,
    0,
    ...le(rate),
  ];
const stream = (data, fast = true) =>
  vgm([
    ...block(data),
    ...enable,
    ...setup(),
    ...(fast ? [0x95, 0, 0, 0, 0] : [0x93, 0, ...le(0), 1, ...le(data.length)]),
    ...wait(data.length * 4),
    0x94,
    0,
    0x66,
  ]);
let song;
test("Stream 0x95 recupera Lá4 440 Hz e exporta MIDI", () => {
  song = C.parseVGM(stream(sine(440)));
  assert.equal(song.pcmSegments.length, 1);
  assert.equal(song.pcmSegments[0].analysis.kind, "tonal");
  assert.equal(song.pcmSegments[0].analysis.note, 69);
  assert.ok(song.tracks[0].notes.every((n) => n.key === 69));
  assert.equal(
    Buffer.from(C.exportMIDI(song).bytes).toString("ascii", 0, 4),
    "MThd",
  );
});
test("Stream 0x93 em comandos mantém duração", () => {
  const s = C.parseVGM(stream(sine(523.251), false));
  assert.equal(s.pcmSegments[0].analysis.note, 72);
  assert.ok(Math.abs(s.pcmSegments[0].end / 44100 - 0.4) < 0.001);
});
test("Escritas DAC diretas produzem nota 69", () => {
  const cmds = [...enable];
  for (const x of sine(440)) cmds.push(0x52, 0x2a, x, 0x73);
  cmds.push(0x52, 0x2b, 0, 0x66);
  const s = C.parseVGM(vgm(cmds));
  assert.equal(s.pcmSegments[0].analysis.note, 69);
});
test("DAC desabilitado não gera notas", () => {
  const s = C.parseVGM(
    vgm([
      ...block(sine(440)),
      ...setup(),
      0x95,
      0,
      0,
      0,
      0,
      ...wait(17640),
      0x66,
    ]),
  );
  assert.equal(s.pcmSegments.length, 0);
});
test("Banco 0, seek E0 e comandos 8n produzem nota 72", () => {
  const data = sine(523.251),
    s = C.parseVGM(
      vgm([
        ...block(data),
        ...enable,
        0xe0,
        0,
        0,
        0,
        0,
        ...data.map(() => 0x84),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].analysis.note, 72);
});
test("Dois blocos concatenados respeitam seek e limites", () => {
  const a = sine(440),
    b = sine(523.251),
    s = C.parseVGM(
      vgm([
        ...block(a),
        ...block(b),
        ...enable,
        0xe0,
        ...le(a.length),
        ...b.map(() => 0x84),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].analysis.note, 72);
});
test("Ruído recebe sugestão de percussão", () => {
  let seed = 42;
  const noise = Array.from({ length: 2205 }, (_, i) => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return Math.round(128 + ((seed / 2 ** 32) * 2 - 1) * 100 * (1 - i / 2205));
  });
  const s = C.parseVGM(stream(noise));
  assert.equal(s.pcmSegments[0].analysis.kind, "percussion");
  assert.ok(s.tracks[0].drum);
});
test("Mudança de nota em áudio contínuo é segmentada", () => {
  const s = C.parseVGM(stream([...sine(440, 0.3), ...sine(523.251, 0.3)]));
  assert.deepEqual(
    [...new Set(s.tracks.flatMap((t) => t.notes.map((n) => n.key)))],
    [69, 72],
  );
});
test("Mapeamento manual muda percussão e permite ignorar", () => {
  const mapped = C.mapPCM(song, { 0: { mode: "percussion", key: 36 } });
  assert.equal(mapped.tracks[0].notes[0].key, 36);
  assert.equal(mapped.tracks[0].drum, true);
  assert.equal(C.mapPCM(song, { 0: { mode: "ignore" } }).tracks.length, 0);
  assert.throws(
    () => C.mapPCM(song, { 0: { mode: "tonal", key: 128 } }),
    /0 e 127/,
  );
});
test("WAV PCM16 tem cabeçalho e tamanho consistentes", () => {
  const b = Buffer.from(C.pcmWAV(song.pcmSegments[0]));
  assert.equal(b.toString("ascii", 0, 4), "RIFF");
  assert.equal(b.readUInt32LE(4), b.length - 8);
  assert.equal(b.readUInt32LE(24), 22050);
  assert.equal(b.readUInt32LE(40), b.length - 44);
  fs.writeFileSync("tests/fixtures/PCM-La4.wav", b);
});
test("Leitura de banco ausente/fim gera erro claro", () => {
  assert.throws(
    () => C.parseVGM(vgm([...enable, 0x84, 0x66])),
    /fora do banco/,
  );
  assert.throws(
    () =>
      C.parseVGM(vgm([...block([128]), ...enable, 0xe0, ...le(2), 0x84, 0x66])),
    /fora do banco/,
  );
});
test("Stream não configurado, frequência zero e índice inválido", () => {
  assert.throws(
    () => C.parseVGM(vgm([0x95, 0, 0, 0, 0, 0x66])),
    /configuração/,
  );
  assert.throws(
    () =>
      C.parseVGM(
        vgm([...block([128]), 0x90, 0, 2, 0, 42, 0x95, 0, 0, 0, 0, 0x66]),
      ),
    /frequência/,
  );
  assert.throws(
    () =>
      C.parseVGM(vgm([...block([128]), ...setup(), 0x95, 0, 9, 0, 0, 0x66])),
    /inexistente/,
  );
});
test("Stream reverso recupera sequência invertida", () => {
  const a = sine(440),
    s = C.parseVGM(
      vgm([
        ...block(a),
        ...enable,
        ...setup(),
        0x95,
        0,
        0,
        0,
        16,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.ok(
    Math.abs(s.pcmSegments[0].data[0] - (a.at(-1) - 128) / 128) < 0.00001,
  );
});
test("Stream loop repete sample até stop FF", () => {
  const a = sine(440, 0.1),
    s = C.parseVGM(
      vgm([
        ...block(a),
        ...enable,
        ...setup(),
        0x95,
        0,
        0,
        0,
        1,
        ...wait(a.length * 4 * 3),
        0x94,
        255,
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments.length, 3);
});
test("Step size e base respeitam dados intercalados", () => {
  const a = sine(440),
    inter = a.flatMap((x) => [0, x]),
    s = C.parseVGM(
      vgm([
        ...block(inter),
        ...enable,
        ...setup(),
        0x91,
        0,
        0,
        2,
        1,
        0x95,
        0,
        0,
        0,
        0,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].analysis.note, 69);
});
test("Segundo YM2612 DAC cria canal independente", () => {
  const a = sine(440),
    s = C.parseVGM(
      vgm([
        ...block(a),
        0xa2,
        0x2b,
        128,
        0x90,
        0,
        0x82,
        0,
        42,
        0x91,
        0,
        0,
        1,
        0,
        0x92,
        0,
        ...le(11025),
        0x95,
        0,
        0,
        0,
        0,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].chip, 1);
});
test("Compressão n-bit shift: 4 bits MSB primeiro", () => {
  const a = sine(440).map((x) => x >> 4);
  if (a.length % 2) a.push(8);
  const packed = [];
  for (let i = 0; i < a.length; i += 2) packed.push(a[i] * 16 + a[i + 1]);
  const s = C.parseVGM(
    vgm([
      ...block([0, ...le(a.length), 8, 4, 1, 0, 0, ...packed], 0x40),
      ...enable,
      ...setup(),
      0x95,
      0,
      0,
      0,
      0,
      ...wait(a.length * 4),
      0x66,
    ]),
  );
  assert.equal(s.pcmSegments[0].analysis.note, 69);
});
test("Tabela/DPCM inválida é rejeitada antes da alocação", () => {
  assert.throws(
    () =>
      C.parseVGM(
        vgm([...block([1, ...le(2), 8, 4, 0, 128, 0, 0], 0x40), 0x66]),
      ),
    /Tabela/,
  );
  assert.throws(
    () =>
      C.parseVGM(
        vgm([...block([0, ...le(0x7fffffff), 8, 4, 0, 0, 0], 0x40), 0x66]),
      ),
    /128 MB/,
  );
});
test("Escritas simultâneas emitem diagnóstico de tempo", () => {
  const s = C.parseVGM(
    vgm([...enable, 0x52, 42, 128, 0x52, 42, 190, 0x62, 0x66]),
  );
  assert.ok(s.warnings.some((w) => w.code === "pcm-same-time"));
});
test("DPCM de 8 bits usa tabela de deltas e acumulador", () => {
  const a = sine(440),
    deltas = a.map((x, i) => (x - (i ? a[i - 1] : 128)) & 255),
    table = [1, 0, 8, 8, 0, 1, ...Array.from({ length: 256 }, (_, i) => i)],
    s = C.parseVGM(
      vgm([
        ...block(table, 127),
        ...block([1, ...le(a.length), 8, 8, 0, 128, 0, ...deltas], 64),
        ...enable,
        ...setup(),
        0x95,
        0,
        0,
        0,
        0,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].analysis.note, 69);
  assert.equal(s.pcmSegments[0].data[0], (a[0] - 128) / 128);
});
test("N-bit por tabela decodifica índices de 4 bits", () => {
  const a = sine(440).map((x) => x >> 4);
  if (a.length % 2) a.push(8);
  const bits = [];
  for (let i = 0; i < a.length; i += 2) bits.push(a[i] * 16 + a[i + 1]);
  const tab = [
      0,
      2,
      8,
      4,
      16,
      0,
      ...Array.from({ length: 16 }, (_, i) => i * 16),
    ],
    s = C.parseVGM(
      vgm([
        ...block(tab, 127),
        ...block([0, ...le(a.length), 8, 4, 2, 0, 0, ...bits], 64),
        ...enable,
        ...setup(),
        0x95,
        0,
        0,
        0,
        0,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments[0].analysis.note, 69);
});
test("Loop VGM não duplica blocos nem muda o índice 0x95", () => {
  const a = sine(440, 0.1),
    cmd = [
      ...enable,
      ...setup(),
      ...block(a),
      0x95,
      0,
      0,
      0,
      0,
      ...wait(a.length * 4),
      0x66,
    ],
    b = vgm(cmd);
  b.writeUInt32LE(256 + enable.length + setup().length - 0x1c, 0x1c);
  const s = C.parseVGM(b, { loops: 3 });
  assert.equal(s.pcmSegments.length, 3);
  assert.ok(s.pcmSegments.every((x) => x.analysis.note === 69));
});
test("0x93 modos milissegundos e até fim do banco", () => {
  for (const mode of [2, 3]) {
    const a = sine(440),
      s = C.parseVGM(
        vgm([
          ...block(a),
          ...enable,
          ...setup(),
          0x93,
          0,
          ...le(0),
          mode,
          ...le(mode === 2 ? 400 : 0),
          ...wait(a.length * 4),
          0x66,
        ]),
      );
    assert.equal(s.pcmSegments[0].analysis.note, 69);
    assert.ok(Math.abs(s.pcmSegments[0].end - 17640) < 2);
  }
});
test("Desligar ambas as saídas de pan silencia PCM", () => {
  const a = sine(440),
    s = C.parseVGM(
      vgm([
        ...block(a),
        ...enable,
        0x53,
        0xb6,
        0,
        ...setup(),
        0x95,
        0,
        0,
        0,
        0,
        ...wait(a.length * 4),
        0x66,
      ]),
    );
  assert.equal(s.pcmSegments.length, 0);
});
test("Tons graves/agudos são identificados dentro de um semitom", () => {
  for (const hz of [55, 110, 220, 880, 1760]) {
    const s = C.parseVGM(stream(sine(hz)));
    assert.ok(
      Math.abs(
        s.pcmSegments[0].analysis.note - (69 + 12 * Math.log2(hz / 440)),
      ) <= 1,
      String(hz),
    );
  }
});
test("Silêncio digital não produz notas PCM falsas", () => {
  const s = C.parseVGM(stream(Array(4410).fill(128)));
  assert.equal(s.pcmSegments.length, 0);
  assert.equal(s.tracks.length, 0);
});
test("Tabelas e comandos truncados têm erros controlados", () => {
  for (const cmd of [
    [0x90, 0],
    [0x93, 0, 0],
    [0x95, 0],
    block([0, 0, 8], 127),
    block([0, ...le(100), 8, 4, 0, 0, 0, 0], 64),
  ])
    assert.throws(
      () => C.parseVGM(vgm([...cmd, 0x66])),
      (e) => e instanceof Error && !(e instanceof RangeError),
    );
});
test("Stream mudo contínuo respeita limite de processamento", () => {
  const cmd = [...block([128]), ...setup(192000), 0x95, 0, 0, 0, 1];
  for (let i = 0; i < 15; i++) cmd.push(...wait(65535));
  cmd.push(0x66);
  assert.throws(() => C.parseVGM(vgm(cmd)), /4 milhões de passos/);
});
const a = sine(440, 0.4),
  b = sine(523.251, 0.4),
  demo = vgm([
    ...block(a),
    ...block(b),
    ...enable,
    ...setup(),
    0x95,
    0,
    0,
    0,
    0,
    ...wait(a.length * 4),
    ...wait(4410),
    0x95,
    0,
    1,
    0,
    0,
    ...wait(b.length * 4),
    0x66,
  ]);
fs.writeFileSync("tests/fixtures/Demonstracao-PCM.vgm", demo);
fs.writeFileSync(
  "tests/fixtures/Demonstracao-PCM.mid",
  C.exportMIDI(C.parseVGM(demo)).bytes,
);
fs.writeFileSync(
  "tests/results/pcm-results.json",
  JSON.stringify(
    {
      total: results.length,
      passed: results.filter((x) => x.status === "PASS").length,
      results,
    },
    null,
    2,
  ),
);
console.log(
  results.filter((x) => x.status === "PASS").length + "/" + results.length,
);
if (results.some((x) => x.status === "FAIL")) process.exitCode = 1;
