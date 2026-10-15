/* Local SF2 sampler: PCM16, zones, loops, tuning and volume envelopes. */
(function (root) {
  "use strict";
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function parseSF2(input) {
    const b = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (b.length < 12 || b.length > 256 * 1024 * 1024)
      throw Error("Soundfont deve ter entre 12 bytes e 256 MB.");
    const d = new DataView(b.buffer, b.byteOffset, b.byteLength),
      str = (p, n) =>
        new TextDecoder("latin1").decode(b.subarray(p, p + n)).split("\0")[0],
      u16 = (p) => d.getUint16(p, true),
      u32 = (p) => d.getUint32(p, true);
    if (str(0, 4) !== "RIFF" || str(8, 4) !== "sfbk")
      throw Error(
        "Selecione uma soundfont SF2 (RIFF/sfbk). SF3 não é suportado.",
      );
    const end = u32(4) + 8;
    if (end > b.length || end < 12) throw Error("Soundfont RIFF truncada.");
    const tables = {},
      info = {};
    let smpl = null,
      has24 = false;
    function chunks(start, end, fn) {
      for (let p = start; p < end; ) {
        if (p + 8 > end) throw Error("Cabeçalho de chunk SF2 truncado.");
        const n = u32(p + 4),
          q = p + 8;
        if (n > end - q) throw Error("Chunk SF2 ultrapassa o arquivo.");
        fn(str(p, 4), q, n);
        p = q + n + (n & 1);
        if (p > end) throw Error("Padding SF2 truncado.");
      }
    }
    chunks(12, end, (tag, p, n) => {
      if (tag !== "LIST") return;
      if (n < 4) throw Error("LIST SF2 inválida.");
      const type = str(p, 4);
      chunks(p + 4, p + n, (t, q, size) => {
        if (type === "INFO") info[t] = str(q, Math.min(size, 8192));
        if (type === "sdta" && t === "smpl") {
          if (size % 2) throw Error("PCM16 SF2 de tamanho ímpar.");
          smpl = { offset: q, length: size / 2 };
        }
        if (type === "sdta" && t === "sm24") has24 = true;
        if (type === "pdta") {
          if (tables[t]) throw Error("Tabela SF2 duplicada: " + t);
          tables[t] = { p: q, size };
        }
      });
    });
    if (!smpl) throw Error("SF2 sem samples PCM16.");
    if (str(smpl.offset, 4) === "OggS")
      throw Error("SF3/Ogg não é suportado nesta prévia. Use SF2 PCM16.");
    const widths = {
      phdr: 38,
      pbag: 4,
      pgen: 4,
      inst: 22,
      ibag: 4,
      igen: 4,
      shdr: 46,
    };
    for (const [t, w] of Object.entries(widths))
      if (!tables[t] || tables[t].size < w || tables[t].size % w)
        throw Error("Tabela SF2 ausente ou inválida: " + t);
    const read = (t, w, fn) =>
      Array.from({ length: tables[t].size / w }, (_, i) =>
        fn(tables[t].p + i * w),
      );
    const ph = read("phdr", 38, (p) => ({
        name: str(p, 20),
        program: u16(p + 20),
        bank: u16(p + 22),
        bag: u16(p + 24),
      })),
      inst = read("inst", 22, (p) => ({ name: str(p, 20), bag: u16(p + 20) })),
      bags = (t) => read(t, 4, (p) => ({ gen: u16(p) })),
      gens = (t) =>
        read(t, 4, (p) => ({
          op: u16(p),
          raw: u16(p + 2),
          val: d.getInt16(p + 2, true),
        }));
    const pb = bags("pbag"),
      ib = bags("ibag"),
      pg = gens("pgen"),
      ig = gens("igen");
    const samples = read("shdr", 46, (p) => ({
      name: str(p, 20),
      start: u32(p + 20),
      end: u32(p + 24),
      loopStart: u32(p + 28),
      loopEnd: u32(p + 32),
      rate: u32(p + 36),
      root: b[p + 40],
      correction: d.getInt8(p + 41),
      link: u16(p + 42),
      type: u16(p + 44),
    }));
    samples.pop();
    for (const s of samples) {
      if (
        s.start >= s.end ||
        s.end > smpl.length ||
        s.rate < 400 ||
        s.rate > 192000 ||
        s.type & 0x8000
      )
        throw Error("Sample SF2 inválido/ROM: " + s.name);
    }
    function zones(h, index, bag, gen, target) {
      const start = h[index].bag,
        end = h[index + 1].bag;
      if (start > end || end >= bag.length)
        throw Error("Índices de zonas SF2 inválidos.");
      let global = new Map(),
        out = [];
      for (let i = start; i < end; i++) {
        const a = bag[i].gen,
          z = bag[i + 1].gen;
        if (a > z || z > gen.length)
          throw Error("Índices de geradores SF2 inválidos.");
        const g = new Map();
        for (let j = a; j < z; j++)
          g.set(
            gen[j].op,
            [43, 44, 41, 53, 54, 57, 58].includes(gen[j].op)
              ? gen[j].raw
              : gen[j].val,
          );
        if (!g.has(target)) {
          if (i !== start) throw Error("Zona global SF2 fora do início.");
          global = g;
          continue;
        }
        out.push(new Map([...global, ...g]));
      }
      return out;
    }
    const iz = inst.slice(0, -1).map((_, i) => zones(inst, i, ib, ig, 53));
    const presets = ph.slice(0, -1).map((p, i) => {
      if (p.program > 127 || p.bank > 16383)
        throw Error("Banco/programa SF2 inválido.");
      const regions = [];
      for (const pr of zones(ph, i, pb, pg, 41)) {
        const id = pr.get(41);
        if (id >= iz.length) throw Error("Instrumento SF2 inexistente.");
        for (const ir of iz[id]) {
          const sid = ir.get(53);
          if (sid >= samples.length) throw Error("Sample SF2 inexistente.");
          const range = (op) => {
            const a = pr.get(op) ?? 0x7f00,
              z = ir.get(op) ?? 0x7f00;
            return [Math.max(a & 255, z & 255), Math.min(a >> 8, z >> 8)];
          };
          const [keyLo, keyHi] = range(43),
            [velLo, velHi] = range(44);
          if (keyLo > keyHi || velLo > velHi) continue;
          const g = new Map(ir);
          for (const [op, v] of pr)
            if (![41, 43, 44, 53, 54, 57, 58].includes(op))
              g.set(
                op,
                (g.get(op) ??
                  {
                    8: 13500,
                    21: -12000,
                    23: -12000,
                    25: -12000,
                    26: -12000,
                    27: -12000,
                    28: -12000,
                    30: -12000,
                    33: -12000,
                    34: -12000,
                    35: -12000,
                    36: -12000,
                    38: -12000,
                    56: 100,
                  }[op] ??
                  0) + v,
              );
          const sample = samples[sid],
            value = (op, def = 0) => (g.has(op) ? g.get(op) : def),
            start = sample.start + value(0) + 32768 * value(4),
            end = sample.end + value(1) + 32768 * value(12),
            ls = sample.loopStart + value(2) + 32768 * value(45),
            le = sample.loopEnd + value(3) + 32768 * value(50);
          if (start < 0 || end > smpl.length || start >= end)
            throw Error("Offsets de sample SF2 inválidos.");
          regions.push({
            sampleId: sid,
            keyLo,
            keyHi,
            velLo,
            velHi,
            start,
            end,
            loopStart: ls,
            loopEnd: le,
            g: Object.fromEntries(g),
            sample,
          });
        }
      }
      return { ...p, index: i, regions };
    });
    if (!presets.length) throw Error("Soundfont sem presets.");
    const warnings = [];
    if (has24)
      warnings.push(
        "Samples de 24 bits: esta prévia utiliza a componente PCM16.",
      );
    if ((tables.pmod?.size || 0) > 10 || (tables.imod?.size || 0) > 10)
      warnings.push(
        "Moduladores SF2 personalizados são aproximados pelos controles básicos.",
      );
    return {
      name: info.INAM || "Soundfont SF2",
      info,
      presets,
      samples,
      bytes: b,
      pcm: smpl,
      warnings,
      size: b.length,
    };
  }
  function choosePreset(font, program, drum = false, explicit = -1) {
    if (explicit >= 0) return font.presets[explicit] || null;
    return (
      font.presets.find(
        (p) => p.bank === (drum ? 128 : 0) && p.program === program,
      ) ||
      font.presets.find((p) => p.bank === (drum ? 128 : 0)) ||
      font.presets[0]
    );
  }
  class Sampler {
    constructor(ctx, font) {
      this.ctx = ctx;
      this.font = font;
      this.cache = new Map();
      this.cacheBytes = 0;
      this.cacheLimit = 64 * 1024 * 1024;
    }
    choose(program, drum = false, explicit = -1) {
      return choosePreset(this.font, program, drum, explicit);
    }
    buffer(r) {
      const key = r.sampleId + ":" + r.start + ":" + r.end;
      let v = this.cache.get(key);
      if (v) {
        this.cache.delete(key);
        this.cache.set(key, v);
        return v;
      }
      const len = r.end - r.start;
      if (len * 4 > 128 * 1024 * 1024)
        throw Error("Sample SF2 grande demais para reproduzir.");
      const buf = this.ctx.createBuffer(1, len, r.sample.rate),
        a = buf.getChannelData(0),
        d = new DataView(
          this.font.bytes.buffer,
          this.font.bytes.byteOffset,
          this.font.bytes.byteLength,
        );
      for (let i = 0; i < len; i++)
        a[i] =
          d.getInt16(this.font.pcm.offset + (r.start + i) * 2, true) / 32768;
      while (this.cacheBytes + len * 4 > this.cacheLimit && this.cache.size) {
        const k = this.cache.keys().next().value,
          x = this.cache.get(k);
        this.cacheBytes -= x.length * 4;
        this.cache.delete(k);
      }
      if (len * 4 <= this.cacheLimit) {
        this.cache.set(key, buf);
        this.cacheBytes += len * 4;
      }
      return buf;
    }
    regions(p, key, velocity) {
      return (
        p?.regions.filter(
          (r) =>
            key >= r.keyLo &&
            key <= r.keyHi &&
            velocity >= r.velLo &&
            velocity <= r.velHi,
        ) || []
      );
    }
    play(
      p,
      key,
      velocity,
      start,
      end,
      points,
      destination,
      offset = 0,
      limit = 16,
    ) {
      const ctx = this.ctx,
        voices = [];
      try {
        for (const r of this.regions(p, key, velocity).slice(
          0,
          Math.max(0, Math.min(16, limit)),
        )) {
          const g = r.g,
            val = (op, def = 0) => g[op] ?? def,
            s = r.sample,
            src = ctx.createBufferSource(),
            gain = ctx.createGain(),
            pan = ctx.createStereoPanner();
          src.buffer = this.buffer(r);
          const proposed = val(58, -1),
            root =
              proposed >= 0 && proposed <= 127
                ? proposed
                : s.root === 255
                  ? 60
                  : s.root,
            scale = val(56, 100),
            fixed = val(46, -1) >= 0 ? val(46) : key,
            cents =
              (fixed - root) * scale + val(51) * 100 + val(52) + s.correction,
            rate = 2 ** (cents / 1200);
          src.playbackRate.setValueAtTime(rate, start);
          const mode = val(54) & 3;
          if (
            (mode === 1 || mode === 3) &&
            r.loopStart >= r.start &&
            r.loopEnd <= r.end &&
            r.loopEnd > r.loopStart
          ) {
            src.loop = true;
            src.loopStart = (r.loopStart - r.start) / s.rate;
            src.loopEnd = (r.loopEnd - r.start) / s.rate;
          }
          const dt = (op) => clamp(2 ** (val(op, -12000) / 1200), 0.001, 20),
            delay = dt(33),
            attack = dt(34),
            hold = dt(35) * 2 ** ((val(39) * (60 - key)) / 1200),
            decay = dt(36) * 2 ** ((val(40) * (60 - key)) / 1200),
            release = clamp(dt(38), 0.005, 3),
            sustain = 10 ** (-clamp(val(37), 0, 1440) / 200),
            base =
              0.28 *
              (velocity / 127) ** 1.5 *
              10 ** (-clamp(val(48), 0, 1440) / 200);
          const initialPan =
            val(17) / 500 +
            (s.type === 4 && !g[17] ? -1 : s.type === 2 && !g[17] ? 1 : 0);
          pan.pan.setValueAtTime(clamp(initialPan, -1, 1), start);
          src.connect(gain);
          gain.connect(pan);
          pan.connect(destination);
          let timeline = [
              { t: 0, v: 0 },
              { t: delay, v: 0 },
              { t: delay + attack, v: base },
              { t: delay + attack + hold, v: base },
              { t: delay + attack + hold + decay, v: base * sustain },
            ],
            elapsed = Math.max(0, offset),
            duration = end - start;
          const level = (t) => {
            let prev = timeline[0];
            for (const next of timeline.slice(1)) {
              if (t <= next.t)
                return (
                  prev.v +
                  (next.v - prev.v) *
                    clamp((t - prev.t) / (next.t - prev.t || 1), 0, 1)
                );
              prev = next;
            }
            return base * sustain;
          };
          gain.gain.setValueAtTime(level(elapsed), start);
          for (const e of timeline)
            if (e.t > elapsed && e.t - elapsed < duration)
              gain.gain.linearRampToValueAtTime(e.v, start + e.t - elapsed);
          gain.gain.setValueAtTime(level(elapsed + duration), end);
          gain.gain.linearRampToValueAtTime(0, end + release);
          for (const pt of points || []) {
            const at = Math.max(start, pt.at);
            if (at >= end) continue;
            src.playbackRate.setValueAtTime(
              rate * 2 ** ((pt.pitch - key) / 12),
              at,
            );
            if (pt.pan !== undefined)
              pan.pan.setValueAtTime(
                clamp(initialPan + (pt.pan - 64) / 64, -1, 1),
                at,
              );
          }
          // Seek a held voice into its sample; sustain-loop samples stay inside their loop.
          let seek = elapsed * rate;
          if (src.loop && seek > src.loopEnd)
            seek =
              src.loopStart +
              ((seek - src.loopStart) % (src.loopEnd - src.loopStart));
          if (!src.loop && seek >= src.buffer.duration) {
            src.disconnect();
            gain.disconnect();
            pan.disconnect();
            continue;
          }
          src.start(start, seek);
          src.stop(end + release + 0.01);
          const voice = {
            source: src,
            start,
            end: end + release,
            stop() {
              try {
                src.stop();
              } catch {}
            },
            disconnect() {
              src.disconnect();
              gain.disconnect();
              pan.disconnect();
            },
          };
          src.onended = () => {
            voice.disconnect();
            voice.onended?.();
          };
          voices.push(voice);
        }
        return voices;
      } catch (error) {
        for (const voice of voices) {
          voice.stop();
          voice.disconnect();
        }
        throw error;
      }
    }
  }
  root.SF2 = { parse: parseSF2, Sampler, choose: choosePreset };
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.SF2;
})(typeof globalThis !== "undefined" ? globalThis : self);
