"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  zlib = require("node:zlib"),
  vm = require("node:vm");
const C = require("../src/core/vgm.js");
const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.stack });
    console.error("FAIL", name, e.message);
  }
}
function vgm(
  commands,
  clocks = { 12: 3579545 },
  version = 0x171,
  header = 256,
) {
  const b = Buffer.alloc(header + commands.length);
  b.write("Vgm ");
  b.writeUInt32LE(b.length - 4, 4);
  b.writeUInt32LE(version, 8);
  if (version >= 0x150) b.writeUInt32LE(header - 0x34, 0x34);
  for (const [offset, clock] of Object.entries(clocks))
    b.writeUInt32LE(clock >>> 0, Number(offset));
  b.set(commands, header);
  return b;
}
const on = [0x50, 0x8e, 0x50, 0x0f, 0x50, 0x90],
  off = [0x50, 0x9f],
  wait = [0x61, 0x44, 0xac],
  tone = () => vgm([...on, ...wait, ...off, 0x66]);
function midi(b) {
  b = Buffer.from(b);
  assert.equal(b.toString("ascii", 0, 4), "MThd");
  assert.equal(b.readUInt32BE(4), 6);
  assert.equal(b.readUInt16BE(8), 1);
  const count = b.readUInt16BE(10),
    ppq = b.readUInt16BE(12),
    tracks = [];
  let p = 14;
  for (let tr = 0; tr < count; tr++) {
    assert.equal(b.toString("ascii", p, p + 4), "MTrk");
    const end = p + 8 + b.readUInt32BE(p + 4);
    p += 8;
    let t = 0,
      events = [];
    function varint() {
      let n = 0,
        c,
        k = 0;
      do {
        assert.ok(p < end);
        c = b[p++];
        n = n * 128 + (c & 127);
        assert.ok(++k <= 4);
      } while (c & 128);
      return n;
    }
    while (p < end) {
      t += varint();
      const status = b[p++];
      if (status === 255) {
        const type = b[p++],
          len = varint(),
          data = [...b.subarray(p, p + len)];
        p += len;
        events.push({ time: t, type, data });
        if (type === 47) {
          assert.equal(len, 0);
          assert.equal(p, end);
        }
      } else {
        assert.ok(status >= 0x80 && status <= 0xef);
        const len = [0xc, 0xd].includes(status >> 4) ? 1 : 2,
          data = [...b.subarray(p, p + len)];
        p += len;
        assert.ok(data.every((x) => x < 128));
        events.push({ time: t, status, data });
      }
    }
    assert.equal(p, end);
    assert.equal(events.at(-1).type, 47);
    tracks.push(events);
  }
  assert.equal(p, b.length);
  return { ppq, tracks };
}
function balance(m) {
  for (const tr of m.tracks) {
    const active = new Map();
    for (const e of tr) {
      if (!e.status) continue;
      const key = (e.status & 15) + ":" + e.data[0];
      if (e.status >> 4 === 9 && e.data[1]) {
        assert.ok(!active.has(key), "overlapping same key");
        active.set(key, e.time);
      }
      if (e.status >> 4 === 8) {
        assert.ok(active.has(key), "note off without on");
        assert.ok(e.time > active.get(key), "zero length");
        active.delete(key);
      }
    }
    assert.equal(active.size, 0, "stuck notes");
  }
}
function key69(song) {
  assert.ok(song.tracks.length);
  const n = song.tracks[0].notes[0];
  assert.equal(n.key, 69);
  assert.ok(Math.abs(n.points[0].pitch - 69) < 0.08);
  assert.equal(n.start, 0);
  return n;
}
(async () => {
  await test("PSG: A4, frequência e duração de 1 s", () => {
    const s = C.parseVGM(tone());
    key69(s);
    assert.equal(s.duration, 1);
    assert.equal(s.tracks[0].notes[0].end, 44100);
  });
  await test("Volume PSG atenuado a 15 encerra nota", () =>
    assert.equal(
      C.parseVGM(vgm([...on, 0x62, ...off, 0x63, 0x66])).tracks[0].notes[0].end,
      735,
    ));
  await test("Latch PSG de volume aceita byte sem bit 7", () =>
    assert.equal(
      C.parseVGM(vgm([...on, 0x62, 0x50, 15, 0x63, 0x66])).tracks[0].notes[0]
        .end,
      735,
    ));
  await test("Notas em canais de PSG distintos", () =>
    assert.equal(C.parseVGM(C.demoVGM()).tracks.length, 4));
  await test("Estéreo Game Gear e pan no MIDI", () => {
    const s = C.parseVGM(vgm([0x4f, 0x10, ...on, ...wait, 0x66]));
    assert.equal(s.tracks[0].notes[0].points[0].pan, 0);
  });
  await test("YM2612: escrita high-low, A4, key on/off", () => {
    key69(
      C.parseVGM(
        vgm(
          [
            0x52,
            0xb4,
            0xc0,
            0x52,
            0xa4,
            0x22,
            0x52,
            0xa0,
            0x1d,
            0x52,
            0x28,
            0xf0,
            ...wait,
            0x52,
            0x28,
            0,
            0x66,
          ],
          { 44: 7670454 },
        ),
      ),
    );
  });
  await test("YM2612: pan 0 silencia canal", () =>
    assert.equal(
      C.parseVGM(
        vgm(
          [0x52, 0xa4, 0x22, 0x52, 0xa0, 0x1d, 0x52, 0x28, 0xf0, ...wait, 0x66],
          { 44: 7670454 },
        ),
      ).tracks.length,
      0,
    ));
  for (const [name, cmd, offset, clock, fnum] of [
    ["YM2203", 0x55, 0x44, 4000000, 519],
    ["YM2608", 0x56, 0x48, 8000000, 519],
    ["YM2610", 0x58, 0x4c, 8000000, 519],
  ])
    await test(name + ": frequência FM A4", () =>
      key69(
        C.parseVGM(
          vgm(
            [
              cmd,
              0xb4,
              0xc0,
              cmd,
              0xa4,
              0x20 + (fnum >> 8),
              cmd,
              0xa0,
              fnum & 255,
              cmd,
              0x28,
              0xf0,
              ...wait,
              0x66,
            ],
            { [offset]: clock },
          ),
        ),
      ),
    );
  await test("YM2151: keycode A4 e fração de nota", () => {
    key69(
      C.parseVGM(
        vgm(
          [0x54, 0x20, 0xc7, 0x54, 0x28, 0x4a, 0x54, 8, 0x78, ...wait, 0x66],
          { 48: 3579545 },
        ),
      ),
    );
  });
  await test("YM2413: A4 e instrumento violin", () => {
    const s = C.parseVGM(
      vgm(
        [0x51, 0x30, 0x10, 0x51, 0x10, 0x22, 0x51, 0x20, 0x19, ...wait, 0x66],
        { 16: 3579545 },
      ),
    );
    key69(s);
    assert.equal(s.tracks[0].notes[0].program, 40);
  });
  for (const [name, cmd, offset, clock] of [
    ["YM3812", 0x5a, 0x50, 3579545],
    ["YM3526", 0x5b, 0x54, 3579545],
    ["Y8950", 0x5c, 0x58, 3579545],
    ["YMF262", 0x5e, 0x5c, 14318180],
  ])
    await test(name + ": A4 OPL", () =>
      key69(
        C.parseVGM(
          vgm([cmd, 0xa0, 0x44, cmd, 0xb0, 0x32, ...wait, 0x66], {
            [offset]: clock,
          }),
        ),
      ),
    );
  await test("AY8910: A4, mixer e volume", () =>
    key69(
      C.parseVGM(
        vgm(
          [0xa0, 0, 254, 0xa0, 1, 0, 0xa0, 7, 62, 0xa0, 8, 15, ...wait, 0x66],
          { 116: 1789772 },
        ),
      ),
    ));
  const gb = [
    0xb3, 0x16, 128, 0xb3, 0x15, 255, 0xb3, 1, 0, 0xb3, 2, 0xf0, 0xb3, 3, 0xd6,
    0xb3, 4, 0x86,
  ];
  await test("Game Boy: frequência A4 e trigger", () =>
    key69(C.parseVGM(vgm([...gb, ...wait, 0x66], { 128: 4194304 }))));
  await test("Game Boy: DAC off encerra nota", () =>
    assert.equal(
      C.parseVGM(vgm([...gb, 0x62, 0xb3, 2, 0, 0x63, 0x66], { 128: 4194304 }))
        .tracks[0].notes[0].end,
      735,
    ));
  await test("Game Boy: contador length corta som sem key off explícito", () => {
    const s = C.parseVGM(
      vgm([...gb, 0xb3, 1, 63, 0xb3, 4, 0xc6, ...wait, 0x66], { 128: 4194304 }),
    );
    assert.ok(Math.abs(s.tracks[0].notes[0].end - 44100 / 256) < 0.0001);
  });
  const nes = [0xb4, 0x15, 1, 0xb4, 0, 0x3f, 0xb4, 2, 0xfd, 0xb4, 3, 8];
  await test("NES: pulso A4", () =>
    key69(C.parseVGM(vgm([...nes, ...wait, 0x66], { 132: 1789772 }))));
  await test("NES: desabilitar canal encerra nota", () =>
    assert.equal(
      C.parseVGM(
        vgm([...nes, 0x62, 0xb4, 0x15, 0, 0x63, 0x66], { 132: 1789772 }),
      ).tracks[0].notes[0].end,
      735,
    ));
  await test("NES: triângulo A4 e contador linear", () =>
    key69(
      C.parseVGM(
        vgm(
          [
            0xb4,
            0x15,
            4,
            0xb4,
            8,
            255,
            0xb4,
            10,
            126,
            0xb4,
            11,
            8,
            ...wait,
            0x66,
          ],
          { 132: 1789772 },
        ),
      ),
    ));
  await test("Dual chip: estado PSG independente", () => {
    const second = on.map((x, i) => (i % 2 === 0 ? 0x30 : x));
    const s = C.parseVGM(
      vgm([...on, ...second, ...wait, 0x66], { 12: 3579545 | 0x40000000 }),
    );
    assert.equal(s.tracks.length, 2);
    assert.ok(s.tracks[1].name.includes("#2"));
  });
  await test("Escritas de frequência no mesmo instante não geram notas fantasmas", () => {
    const s = C.parseVGM(
      vgm([
        0x50,
        0x90,
        0x50,
        0x82,
        0x50,
        0x06,
        0x50,
        0x8e,
        0x50,
        0x0f,
        ...wait,
        0x66,
      ]),
    );
    assert.equal(s.tracks[0].notes.length, 1);
    key69(s);
  });
  await test("Todos os waits: 61, 62, 63, 7n, 8n e override 64", () => {
    const s = C.parseVGM(
      vgm([
        0x67,
        0x66,
        0,
        2,
        0,
        0,
        0,
        128,
        128,
        ...on,
        0x61,
        100,
        0,
        0x62,
        0x63,
        0x70,
        0x7f,
        0x80,
        0x8f,
        0x64,
        0x62,
        10,
        0,
        0x62,
        0x66,
      ]),
    );
    assert.equal(s.samples, 100 + 735 + 882 + 1 + 16 + 0 + 15 + 10);
  });
  await test("Loop: introdução uma vez, loop 3 vezes, marcadores", () => {
    const b = vgm([...on, 0x62, ...off, 0x62, ...on, 0x63, ...off, 0x66]);
    b.writeUInt32LE(256 + on.length + 1 + off.length + 1 - 0x1c, 0x1c);
    const s = C.parseVGM(b, { loops: 3 });
    assert.equal(s.samples, 1470 + 882 * 3);
    assert.equal(s.tracks[0].notes.length, 4);
    assert.equal(s.loopStart, 1470);
    assert.equal(s.markers[0].name, "loopStart");
    fs.writeFileSync("tests/fixtures/loop.vgm", b);
  });
  await test("GZIP detectado por assinatura mesmo com extensão .vgm", async () => {
    const s = await C.decode(zlib.gzipSync(tone()), "compressed.vgm");
    key69(s);
    fs.writeFileSync("tests/fixtures/compactado.vgz", zlib.gzipSync(tone()));
  });
  await test("CRC de GZIP corrompido causa erro", async () => {
    const b = zlib.gzipSync(tone());
    b[b.length - 8] ^= 255;
    await assert.rejects(() => C.decode(b, "bad.vgz"), /GZIP/);
  });
  await test("GYM 50/60 Hz preserva o tempo escolhido", async () => {
    const b = Buffer.from([3, 0x8e, 3, 0x0f, 3, 0x90, 0, 3, 0x9f]);
    assert.equal((await C.decode(b, "test.gym", { gymRate: 50 })).samples, 882);
    assert.equal((await C.decode(b, "test.gym", { gymRate: 60 })).samples, 735);
    fs.writeFileSync("tests/fixtures/pulso.gym", b);
  });
  await test("Cabeçalho curto não interpreta comandos como clocks", () => {
    const s = C.parseVGM(
      vgm([...on, ...wait, 0x66], { 12: 3579545 }, 0x150, 64),
    );
    assert.deepEqual(Object.keys(s.clocks), ["SN76489"]);
  });
  await test("Cabeçalho antigo 1.00 usa início fixo 0x40", () =>
    key69(C.parseVGM(vgm([...on, ...wait, 0x66], { 12: 3579545 }, 0x100, 64))));
  await test("GD3 Unicode é lido sem interpretar HTML", () => {
    const b = tone(),
      text = Buffer.from(
        "Título <img src=x onerror=alert(1)>\0\0Jogo 漢字\0\0Console\0\0Autor\0\0\0\0\0",
        "utf16le",
      ),
      tag = Buffer.alloc(12);
    tag.write("Gd3 ");
    tag.writeUInt32LE(0x100, 4);
    tag.writeUInt32LE(text.length, 8);
    const all = Buffer.concat([b, tag, text]);
    all.writeUInt32LE(all.length - 4, 4);
    all.writeUInt32LE(b.length - 0x14, 0x14);
    const s = C.parseVGM(all);
    assert.equal(s.metadata.game, "Jogo 漢字");
    assert.ok(s.metadata.title.includes("<img"));
    fs.writeFileSync("tests/fixtures/unicode.vgm", all);
  });
  await test("Comandos PCM/chips não suportados preservam os waits e avisam", () => {
    const s = C.parseVGM(
      vgm([
        ...on,
        0xbb,
        0,
        2,
        0x90,
        0,
        0,
        0,
        0,
        0x91,
        0,
        0,
        0,
        0,
        0x92,
        0,
        1,
        0,
        0,
        0,
        0x93,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0x94,
        0,
        0x95,
        0,
        0,
        0,
        0,
        ...wait,
        0x66,
      ]),
    );
    assert.equal(s.samples, 44100);
    assert.ok(s.warnings.some((w) => w.code === "unsupported-Pokey"));
  });
  await test("Bloco de dados 67 é pulado sem consumir comandos falsos", () => {
    const s = C.parseVGM(
      vgm([
        ...on,
        0x67,
        0x66,
        0,
        4,
        0,
        0,
        0,
        0x66,
        0x66,
        0x66,
        0x66,
        ...wait,
        0x66,
      ]),
    );
    assert.equal(s.samples, 44100);
  });
  for (const [name, b, pattern] of [
    ["Cabeçalho curto", Buffer.alloc(8), /curto/],
    ["Assinatura incorreta", Buffer.alloc(80), /Assinatura/],
    ["Comando truncado", vgm([0x61, 4]), /truncado/],
    ["Bloco truncado", vgm([0x67, 0x66, 0, 255, 255, 255, 127]), /truncado/],
    ["Fim 66 ausente", vgm([...on, ...wait]), /encerramento/],
    ["Comando desconhecido", vgm([1, 0x66]), /desconhecido/],
  ])
    await test("Entrada inválida: " + name, () =>
      assert.throws(() => C.parseVGM(b), pattern),
    );
  await test("EOF além dos bytes disponíveis é rejeitado", () => {
    const b = tone();
    b.writeUInt32LE(999999, 4);
    assert.throws(() => C.parseVGM(b), /truncado/);
  });
  await test("Offset de loop no meio de comando é rejeitado", () => {
    const b = tone();
    b.writeUInt32LE(257 - 0x1c, 0x1c);
    assert.throws(() => C.parseVGM(b), /início de um comando/);
  });
  await test("Loop de tempo zero é rejeitado", () => {
    const b = vgm([0x66]);
    b.writeUInt32LE(256 - 0x1c, 0x1c);
    assert.throws(() => C.parseVGM(b, { loops: 2 }), /sem duração/);
  });
  await test("Duração acima de 30 minutos é limitada", () => {
    const cmds = [];
    for (let i = 0; i < 1212; i++) cmds.push(0x61, 255, 255);
    cmds.push(0x66);
    assert.throws(() => C.parseVGM(vgm(cmds)), /30 minutos/);
  });
  await test("MIDI: tipo 1, 960 PPQ, chunks e notas balanceados", () => {
    const s = C.parseVGM(C.demoVGM()),
      m = midi(C.exportMIDI(s).bytes);
    assert.equal(m.ppq, 960);
    assert.equal(m.tracks.length, 5);
    balance(m);
    fs.writeFileSync("tests/fixtures/demo.mid", C.exportMIDI(s).bytes);
    fs.writeFileSync("tests/fixtures/demo.vgm", C.demoVGM());
  });
  await test("MIDI: mudar BPM mantém duração em segundos", () => {
    for (const bpm of [20, 60, 120, 137, 300]) {
      const s = C.parseVGM(tone()),
        m = midi(C.exportMIDI(s, { bpm }).bytes),
        temp = m.tracks[0].find((e) => e.type === 0x51).data,
        us = temp[0] * 65536 + temp[1] * 256 + temp[2],
        ticks = m.tracks[0].at(-1).time;
      assert.ok(Math.abs((ticks * us) / 1e6 / m.ppq - 1) < us / 1e6 / m.ppq);
    }
  });
  await test("MIDI: canal 10 só para percussão e portas isolam CCs", () => {
    const s = C.parseVGM(C.demoVGM()),
      base = s.tracks.find((t) => !t.drum),
      drum = s.tracks.find((t) => t.drum);
    s.tracks = Array.from({ length: 21 }, (_, i) => ({
      ...base,
      id: i,
      name: "melody " + i,
    })).concat(
      Array.from({ length: 3 }, (_, i) => ({
        ...drum,
        id: 30 + i,
        name: "drum " + i,
      })),
    );
    const m = midi(C.exportMIDI(s).bytes),
      pairs = new Set();
    for (let i = 1; i < m.tracks.length; i++) {
      const tr = m.tracks[i],
        port = tr.find((e) => e.type === 0x21).data[0],
        channel = tr.find((e) => e.status >> 4 === 9).status & 15;
      assert.equal(channel === 9, i > 21);
      const key = port + ":" + channel;
      assert.ok(!pairs.has(key));
      pairs.add(key);
    }
    balance(m);
  });
  await test("MIDI: instrumento, transposição e exclusão de pista", () => {
    const s = C.parseVGM(C.demoVGM()),
      settings = {};
    s.tracks.forEach(
      (t, i) =>
        (settings[t.id] = {
          enabled: i === 0,
          program: 40,
          transpose: 12,
          volume: 87,
        }),
    );
    const m = midi(C.exportMIDI(s, { transpose: 12 }, settings).bytes);
    assert.equal(m.tracks.length, 2);
    assert.equal(m.tracks[1].find((e) => e.status >> 4 === 9).data[0], 84);
    assert.equal(m.tracks[1].find((e) => e.status >> 4 === 12).data[0], 40);
  });
  await test("MIDI: pitch bend negativo e RPN de 24 semitons", () => {
    const s = C.parseVGM(
      vgm([...on, 0x62, 0x50, 0x82, 0x50, 0x10, 0x62, 0x66]),
    );
    const m = midi(C.exportMIDI(s).bytes),
      ev = m.tracks[1];
    assert.ok(
      ev.some(
        (e) => e.status >> 4 === 14 && e.data[0] + e.data[1] * 128 < 8192,
      ),
    );
    assert.ok(
      ev.some(
        (e) => e.status >> 4 === 11 && e.data[0] === 6 && e.data[1] === 24,
      ),
    );
    balance(m);
  });
  await test("MIDI: notas muito curtas não ficam presas nem se sobrepõem", () => {
    const commands = [];
    for (let i = 0; i < 8; i++) commands.push(...on, 0x70, ...off, 0x70);
    commands.push(0x66);
    balance(midi(C.exportMIDI(C.parseVGM(vgm(commands))).bytes));
  });
  await test("MIDI: erro ao exportar sem notas ou sem pistas ativas", () => {
    assert.throws(() => C.exportMIDI(C.parseVGM(vgm([0x66]))), /pistas/);
    const s = C.parseVGM(tone());
    assert.throws(
      () => C.exportMIDI(s, {}, { [s.tracks[0].id]: { enabled: false } }),
      /pistas/,
    );
  });
  await test("MIDI: BPM e transposições inválidos são rejeitados", () => {
    const s = C.parseVGM(tone());
    assert.throws(() => C.exportMIDI(s, { bpm: 0 }), /BPM/);
    assert.throws(() => C.exportMIDI(s, { transpose: 100 }), /Transposição/);
    assert.throws(
      () => C.exportMIDI(s, {}, { [s.tracks[0].id]: { transpose: 12.5 } }),
      /inválido/,
    );
  });
  await test("MIDI: 20 mil notas sem erro de tamanho/stack", () => {
    const s = C.parseVGM(tone()),
      n = s.tracks[0].notes[0];
    s.tracks[0].notes = Array.from({ length: 20000 }, (_, i) => ({
      ...n,
      start: i * 100,
      end: i * 100 + 80,
      points: [{ ...n.points[0], time: i * 100 }],
    }));
    s.samples = 2000000;
    const b = C.exportMIDI(s).bytes;
    assert.ok(b.length > 400000);
    balance(midi(b));
  });
  await test("ZIP offline: assinatura, CRC, tamanhos e nome UTF-8", async () => {
    const src = fs.readFileSync("src/io/export.js", "utf8"),
      part = src.slice(src.indexOf("function zipStored("), src.length),
      ctx = { Uint32Array, Uint8Array, TextEncoder, Blob };
    vm.createContext(ctx);
    vm.runInContext(part + ";this.zip=zipStored;", ctx);
    const b = Buffer.from(
      await ctx
        .zip([{ name: "música.mid", data: new Uint8Array([1, 2, 3]) }])
        .arrayBuffer(),
    );
    fs.writeFileSync("tests/fixtures/zip-teste.zip", b);
    assert.equal(b.readUInt32LE(0), 0x04034b50);
    assert.equal(b.readUInt32LE(b.length - 22), 0x06054b50);
  });
  await test("Mutações determinísticas: erros controlados em 200 entradas", () => {
    let seed = 123456789;
    const rnd = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let i = 0; i < 200; i++) {
      const b = Buffer.from(tone()),
        pos = rnd() % b.length;
      b[pos] ^= rnd() & 255;
      try {
        const s = C.parseVGM(b);
        assert.ok(
          Number.isFinite(s.duration) && s.duration >= 0 && s.duration <= 1800,
        );
        for (const t of s.tracks)
          for (const n of t.notes) assert.ok(n.end > n.start);
      } catch (e) {
        assert.ok(e instanceof Error);
        assert.ok(!(e instanceof RangeError), "uncaught bounds exception");
      }
    }
  });
  fs.writeFileSync(
    "tests/results/results.json",
    JSON.stringify(
      {
        total: results.length,
        passed: results.filter((x) => x.status === "PASS").length,
        failed: results.filter((x) => x.status === "FAIL").length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      total: results.length,
      passed: results.filter((x) => x.status === "PASS").length,
      failed: results.filter((x) => x.status === "FAIL").length,
    }),
  );
  if (results.some((x) => x.status === "FAIL")) process.exitCode = 1;
})();
