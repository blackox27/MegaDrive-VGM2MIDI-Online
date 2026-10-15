const C = require("../src/core/vgm.js"),
  fs = require("fs"),
  assert = require("assert/strict");
const results = [];
const le = (n) => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
function vgm(cmd, clock = 0x0c, hz = 3579545) {
  const b = Buffer.alloc(256 + cmd.length);
  b.write("Vgm ");
  b.writeUInt32LE(b.length - 4, 4);
  b.writeUInt32LE(0x171, 8);
  b.writeUInt32LE(204, 0x34);
  b.writeUInt32LE(hz, clock);
  b.set(cmd, 256);
  return b;
}
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.stack });
    console.log("FAIL", name, e.message);
  }
}
const w = [0x61, 0x44, 0xac],
  reg = (a, d) => [0xc0, a & 255, a >> 8, d];
test("HuC6280: tom, pan e key-on/off", () => {
  const per = Math.round(3579545 / (440 * 32)),
    s = C.parseVGM(
      vgm(
        [
          0xb9,
          0,
          0,
          0xb9,
          1,
          255,
          0xb9,
          5,
          0xf0,
          0xb9,
          2,
          per & 255,
          0xb9,
          3,
          per >> 8,
          0xb9,
          4,
          159,
          ...w,
          0xb9,
          4,
          0,
          0x66,
        ],
        0xa4,
      ),
    );
  assert.equal(s.tracks.length, 1);
  assert.equal(s.tracks[0].notes[0].key, 69);
  assert.equal(s.tracks[0].notes[0].points[0].pan, 0);
});
test("HuC6280: ruído e aviso DDA/LFO", () => {
  const s = C.parseVGM(
    vgm(
      [
        0xb9,
        0,
        4,
        0xb9,
        1,
        255,
        0xb9,
        5,
        255,
        0xb9,
        7,
        128,
        0xb9,
        4,
        159,
        ...w,
        0xb9,
        9,
        1,
        0xb9,
        4,
        223,
        0x66,
      ],
      0xa4,
    ),
  );
  assert.ok(s.tracks.some((t) => t.drum));
  assert.ok(s.warnings.some((w) => w.code === "huc-dda"));
  assert.ok(s.warnings.some((w) => w.code === "huc-lfo"));
});
test("SAA1099: frequência, octave e estéreo", () => {
  const clock = 8000000,
    oct = 3,
    f = 511 - Math.round(((clock / 512) * 2 ** oct) / 440),
    s = C.parseVGM(
      vgm(
        [
          0xbd,
          0,
          15,
          0xbd,
          8,
          f,
          0xbd,
          16,
          oct,
          0xbd,
          20,
          1,
          0xbd,
          28,
          1,
          ...w,
          0x66,
        ],
        0xc8,
        clock,
      ),
    );
  assert.equal(s.tracks[0].notes[0].key, 69);
  assert.equal(s.tracks[0].notes[0].points[0].pan, 0);
});
test("SCC/K051649: frequência e key-on", () => {
  const per = Math.round(1789773 / (440 * 16)) - 1,
    s = C.parseVGM(
      vgm(
        [
          0xd2,
          1,
          0,
          per & 255,
          0xd2,
          1,
          1,
          per >> 8,
          0xd2,
          2,
          0,
          15,
          0xd2,
          3,
          0,
          1,
          ...w,
          0xd2,
          3,
          0,
          0,
          0x66,
        ],
        0x9c,
        1789773,
      ),
    );
  assert.equal(s.tracks[0].notes[0].key, 69);
});
test("SCC: segundo chip independente", () => {
  const s = C.parseVGM(
    vgm(
      [
        0xd2,
        129,
        0,
        250,
        0xd2,
        129,
        1,
        0,
        0xd2,
        130,
        0,
        15,
        0xd2,
        131,
        0,
        1,
        ...w,
        0x66,
      ],
      0x9c,
      1789773,
    ),
  );
  assert.ok(s.tracks[0].name.includes("#2"));
});
const data = Array.from({ length: 4096 }, (_, i) =>
    Math.round(128 + 100 * Math.sin((2 * Math.PI * 440 * i) / 31250)),
  ),
  rom = [
    0x67,
    0x66,
    0x80,
    ...le(8 + data.length),
    ...le(data.length),
    ...le(0),
    ...data,
  ];
const cmds = [
  ...rom,
  ...reg(2, 127),
  ...reg(3, 127),
  ...reg(6, 15),
  ...reg(7, 255),
  ...reg(0x84, 0),
  ...reg(0x85, 0),
  ...reg(0x86, 2),
  ...w,
  0x66,
];
test("SegaPCM: ROM e nota PCM recuperada", () => {
  const s = C.parseVGM(vgm(cmds, 0x38, 4000000));
  assert.ok(s.pcmSegments.length >= 1);
  assert.ok(s.pcmSegments[0].source.startsWith("SegaPCM"));
  assert.ok(Math.abs(s.pcmSegments[0].analysis.note - 69) <= 1);
  assert.ok(s.pcmSegments[0].end < 44100);
  fs.writeFileSync("tests/fixtures/Demo-SegaPCM.vgm", vgm(cmds, 0x38, 4000000));
});
test("SegaPCM: ausência/offset inválido da ROM é diagnosticado", () => {
  const s = C.parseVGM(
    vgm([...reg(2, 127), ...reg(0x86, 2), ...w, 0x66], 0x38, 4000000),
  );
  assert.ok(s.warnings.some((w) => w.code === "segapcm-rom"));
  assert.throws(
    () =>
      C.parseVGM(
        vgm(
          [0x67, 0x66, 128, ...le(9), ...le(1), ...le(2), 0, 0x66],
          0x38,
          4000000,
        ),
      ),
    /ROM/,
  );
});
test("MIDI preserva banco e programa selecionados na SF2", () => {
  const s = C.parseVGM(C.demoVGM()),
    t = s.tracks[0],
    m = Buffer.from(
      C.exportMIDI(s, {}, { [t.id]: { program: 81, bank: 7, sfPreset: 2 } })
        .bytes,
    );
  assert.ok(m.includes(Buffer.from([0xb0, 0, 0])));
  assert.ok(m.includes(Buffer.from([0xb0, 32, 7])));
  assert.ok(m.includes(Buffer.from([0xc0, 81])));
  assert.throws(
    () => C.exportMIDI(s, {}, { [t.id]: { bank: 16384 } }),
    /Banco/,
  );
});
test("Preset melódico em pista de ruído sai em canal melódico", () => {
  const song = C.parseVGM(C.demoVGM()),
    tr = song.tracks.find((t) => t.drum),
    settings = {};
  for (const t of song.tracks)
    settings[t.id] = { enabled: t === tr, program: 61, bank: 0, sfPreset: 0 };
  const b = Buffer.from(C.exportMIDI(song, {}, settings).bytes);
  assert.ok(b.includes(Buffer.from([0xc0, 61])));
  assert.ok(
    b.includes(Buffer.from([0x90, 42, 100])) ||
      b.includes(Buffer.from([0x90, 37, 100])),
  );
  assert.ok(!b.includes(Buffer.from([0x99, 42, 100])));
});
test("SegaPCM respeita bank shift zero explicitamente configurado", () => {
  const cmd = [
      ...rom,
      ...reg(2, 127),
      ...reg(3, 127),
      ...reg(6, 15),
      ...reg(7, 255),
      ...reg(0x84, 0),
      ...reg(0x85, 0),
      ...reg(0x86, 0x12),
      0x61,
      0x9d,
      0x08,
      0x66,
    ],
    b = vgm(cmd, 0x38, 4000000);
  b.writeUInt32LE(0x00f00000, 0x3c);
  const s = C.parseVGM(b);
  assert.ok(s.pcmSegments.length > 0);
  assert.ok(!s.warnings.some((w) => w.code === "segapcm-rom"));
});
fs.writeFileSync(
  "tests/results/chips-results.json",
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
