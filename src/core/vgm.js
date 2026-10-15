/* VGM2MID Web 3.0 — independent browser implementation, 2026. */
(function (root) {
  "use strict";
  const SR = 44100,
    MAX_BYTES = 128 * 1024 * 1024,
    MAX_TIME = SR * 1800;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const pitch = (f) => 69 + 12 * Math.log2(f / 440);
  // PCM/DAC recovery and monophonic transcription. No external dependencies.
  class PCM {
    constructor(e) {
      this.e = e;
      this.banks = new Map();
      this.seen = new Set();
      this.streams = new Map();
      this.cursor = 0;
      this.enabled = [false, false];
      this.pan = [64, 64];
      this.muted = [false, false];
      this.streamSteps = 0;
      this.active = [null, null];
      this.segments = [];
      this.count = 0;
      this.bankBytes = 0;
      this.waveBytes = 0;
      this.table = null;
      this.sources = [];
    }
    boundary(ch, time = this.e.time) {
      const a = this.active[ch];
      if (!a) return;
      this.active[ch] = null;
      if (a.n < 8) return;
      const last = a.times[a.n - 1],
        dt = a.n > 1 ? (last - a.times[0]) / (a.n - 1) : 1;
      const end = Math.min(time, last + Math.min(441, Math.max(1, dt)));
      if (end <= a.times[0]) return;
      const rate = 22050,
        length = Math.ceil(((end - a.times[0]) * rate) / SR);
      this.waveBytes += length * 4;
      if (this.waveBytes > 64 * 1024 * 1024)
        throw Error(
          "PCM: limite de 64 MB de áudio recuperado. Reduza os loops.",
        );
      const data = new Float32Array(length);
      let j = 0;
      for (let i = 0; i < length; i++) {
        const t = a.times[0] + (i * SR) / rate;
        while (j + 1 < a.n && a.times[j + 1] <= t) j++;
        data[i] = (a.values[j] - 128) / 128;
      }
      // Split at sustained digital silence; long continuous passages remain a single editable region.
      const ranges = [];
      let start = 0,
        silent = -1;
      for (let i = 1; i < data.length; i++) {
        if (Math.abs(data[i] - data[i - 1]) < 1 / 256) {
          if (silent < 0) silent = i;
          if (i - silent === Math.round(rate * 0.035)) {
            if (silent - start > rate * 0.008) ranges.push([start, silent]);
            start = -1;
          }
        } else {
          silent = -1;
          if (start < 0) start = i;
        }
      }
      if (start >= 0 && data.length - start > rate * 0.008)
        ranges.push([start, data.length]);
      for (const [lo, hi] of ranges) {
        if (this.segments.length >= 2048)
          throw Error("PCM: limite de 2048 trechos. Reduza os loops.");
        const wave = data.slice(lo, hi);
        let energy = 0,
          mean = 0;
        for (const x of wave) mean += x;
        mean /= wave.length;
        for (const x of wave) energy += (x - mean) ** 2;
        if (energy / wave.length < 0.00003) continue;
        const seg = {
          id: this.segments.length,
          chip: ch,
          source: this.sources[ch] || "YM2612" + (ch ? " #2" : "") + " DAC",
          start: a.times[0] + (lo * SR) / rate,
          end: a.times[0] + (hi * SR) / rate,
          sampleRate: rate,
          data: wave,
          pan: a.pan,
        };
        seg.analysis = analyzePCM(seg);
        this.segments.push(seg);
      }
    }
    capture(ch, value, time = this.e.time) {
      if (this.e.options.pcm === false || !this.enabled[ch] || this.muted[ch])
        return;
      if (++this.count > 16000000)
        throw Error(
          "PCM: limite de 16 milhões de escritas DAC. Reduza os loops.",
        );
      let a = this.active[ch];
      if (a && time - a.times[a.n - 1] > 441) {
        this.boundary(ch, a.times[a.n - 1] + Math.min(441, a.dt || 4));
        a = null;
      }
      if (!a) {
        a = {
          times: new Float64Array(4096),
          values: new Uint8Array(4096),
          n: 0,
          pan: this.pan[ch],
          dt: 4,
        };
        this.active[ch] = a;
      }
      if (a.n && time === a.times[a.n - 1]) {
        a.values[a.n - 1] = value;
        this.e.warn(
          "pcm-same-time",
          "Há escritas DAC no mesmo instante: sem tempo entre elas, apenas o último valor pode ser recuperado (comum em GYM).",
        );
        return;
      }
      if (a.n === a.times.length) {
        const t = new Float64Array(a.n * 2),
          v = new Uint8Array(a.n * 2);
        t.set(a.times);
        v.set(a.values);
        a.times = t;
        a.values = v;
      }
      if (a.n) a.dt = time - a.times[a.n - 1];
      a.times[a.n] = time;
      a.values[a.n++] = value;
    }
    register(ch, port, reg, value) {
      if (port === 1 && reg === 0xb6) {
        const p = value >> 6;
        const pan = p === 2 ? 0 : p === 1 ? 127 : 64;
        if (pan !== this.pan[ch] || !p !== this.muted[ch]) this.boundary(ch);
        this.pan[ch] = pan;
        this.muted[ch] = !p;
      }
      if (port) return;
      if (reg === 0x2b) {
        const on = !!(value & 128);
        if (!on) this.boundary(ch);
        this.enabled[ch] = on;
      }
      if (reg === 0x2a) this.capture(ch, value);
    }
    unpack(b) {
      if (b.length < 10) throw Error("Bloco PCM comprimido truncado.");
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength),
        type = b[0],
        size = d.getUint32(1, true),
        bd = b[5],
        bc = b[6],
        sub = b[7],
        add = d.getUint16(8, true);
      if (size > MAX_BYTES - this.bankBytes)
        throw Error("Banco PCM descompactado excede 128 MB.");
      if (
        bd < 1 ||
        bd > 16 ||
        bc < 1 ||
        bc > 16 ||
        bc > bd ||
        type > 1 ||
        (!type && sub > 2)
      )
        throw Error("Compressão PCM não suportada ou inválida.");
      const width = Math.ceil(bd / 8);
      if (size % width || Math.ceil(((size / width) * bc) / 8) > b.length - 10)
        throw Error("Dados PCM comprimidos truncados.");
      const tab = this.table;
      if (
        (type === 1 || sub === 2) &&
        (!tab ||
          tab.type !== type ||
          tab.bd !== bd ||
          tab.bc !== bc ||
          tab.sub !== sub)
      )
        throw Error("Tabela de compressão PCM ausente ou incompatível.");
      const out = new Uint8Array(size);
      let bit = 80,
        acc = add;
      for (let p = 0; p < size; p += width) {
        let val = 0,
          remain = bc,
          shift = 0;
        while (remain) {
          const n = Math.min(8, remain);
          let part = 0;
          for (let k = 0; k < n; k++, bit++)
            part = (part << 1) | ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
          val |= part << shift;
          shift += n;
          remain -= n;
        }
        if (type === 1 || sub === 2) {
          if (val >= tab.values.length)
            throw Error("Índice fora da tabela PCM.");
          val = tab.values[val];
        }
        if (type === 1) {
          acc = (acc + val) & ((1 << bd) - 1);
          val = acc;
        } else if (sub !== 2) val = (sub === 1 ? val << (bd - bc) : val) + add;
        out[p] = val & 255;
        if (width === 2) out[p + 1] = (val >> 8) & 255;
      }
      return out;
    }
    block(type, b, at) {
      if (this.seen.has(at)) return;
      this.seen.add(at);
      if (type === 0x7f) {
        if (b.length < 6) throw Error("Tabela PCM truncada.");
        const width = Math.ceil(b[2] / 8),
          n = b[4] | (b[5] << 8);
        if (width < 1 || width > 2 || b.length < 6 + n * width)
          throw Error("Tabela PCM inválida.");
        this.table = {
          type: b[0],
          sub: b[1],
          bd: b[2],
          bc: b[3],
          values: Array.from(
            { length: n },
            (_, i) =>
              b[6 + i * width] | (width === 2 ? b[7 + i * width] << 8 : 0),
          ),
        };
        return;
      }
      if (type >= 0x80) return;
      const id = type & 63,
        data = type >= 0x40 ? this.unpack(b) : b;
      this.bankBytes += data.length;
      if (this.bankBytes > MAX_BYTES) throw Error("Bancos PCM excedem 128 MB.");
      let bank = this.banks.get(id);
      if (!bank) {
        bank = { blocks: [], size: 0 };
        this.banks.set(id, bank);
      }
      bank.blocks.push({ offset: bank.size, data });
      bank.size += data.length;
    }
    byte(id, pos) {
      const bank = this.banks.get(id);
      if (!bank || pos < 0 || pos >= bank.size)
        throw Error(
          "Leitura PCM fora do banco " + id + " (posição " + pos + ").",
        );
      let lo = 0,
        hi = bank.blocks.length - 1;
      while (lo < hi) {
        const m = (lo + hi + 1) >> 1;
        if (bank.blocks[m].offset <= pos) lo = m;
        else hi = m - 1;
      }
      const b = bank.blocks[lo];
      return b.data[pos - b.offset];
    }
    legacy() {
      const v = this.byte(0, this.cursor++);
      this.capture(0, v);
    }
    stop(s) {
      if (s.active) this.boundary(s.ch, this.e.time);
      s.active = false;
    }
    command(cmd, b) {
      const id = b[0],
        dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (cmd === 0x94 && id === 255) {
        for (const s of this.streams.values()) this.stop(s);
        return;
      }
      if (id === 255) return;
      let s = this.streams.get(id);
      if (cmd === 0x90) {
        if (s) this.stop(s);
        s = {
          ch: b[1] >> 7,
          supported: (b[1] & 127) === 2 && b[2] === 0 && b[3] === 0x2a,
          bank: 0,
          step: 1,
          base: 0,
          freq: 0,
          active: false,
        };
        this.streams.set(id, s);
        if (!s.supported)
          this.e.warn(
            "pcm-stream-chip",
            "Streams para chips/registros diferentes do DAC YM2612 não são transcritos.",
          );
        return;
      }
      if (!s)
        throw Error("Stream DAC " + id + " usado antes da configuração 0x90.");
      if (cmd === 0x91) {
        s.bank = b[1];
        s.step = b[2] || 1;
        s.base = b[3];
        return;
      }
      if (cmd === 0x92) {
        s.freq = dv.getUint32(1, true);
        if (s.freq > 192000)
          throw Error("Frequência de stream DAC acima de 192 kHz.");
        return;
      }
      if (cmd === 0x94) {
        this.stop(s);
        return;
      }
      if (!s.supported) return;
      if (!s.freq) throw Error("Stream DAC sem frequência válida.");
      this.stop(s);
      const bank = this.banks.get(s.bank);
      if (!bank) throw Error("Banco do stream DAC ausente.");
      let offset, length, flags;
      if (cmd === 0x95) {
        const block = bank.blocks[dv.getUint16(1, true)];
        if (!block) throw Error("Bloco de stream DAC inexistente.");
        offset = block.offset + s.base;
        length = Math.max(0, Math.ceil((block.data.length - s.base) / s.step));
        flags = b[3];
        s.loop = !!(flags & 1);
      } else {
        offset = dv.getUint32(1, true);
        if (offset === 0xffffffff) offset = s.origin ?? 0;
        else offset += s.base;
        flags = b[5];
        const n = dv.getUint32(6, true),
          mode = flags & 15;
        s.loop = !!(flags & 128);
        if (mode === 0) length = s.length || 0;
        else if (mode === 1) length = n;
        else if (mode === 2) length = Math.floor((n * s.freq) / 1000);
        else if (mode === 3)
          length = Math.max(0, Math.ceil((bank.size - offset) / s.step));
        else throw Error("Modo de comprimento DAC não suportado.");
      }
      if (
        length &&
        (offset >= bank.size || offset + (length - 1) * s.step >= bank.size)
      )
        throw Error("Comprimento do stream DAC ultrapassa o banco.");
      s.origin = offset;
      s.length = length;
      s.reverse = !!(flags & 16);
      s.index = 0;
      s.next = this.e.time;
      s.active = length > 0;
    }
    advance(end) {
      for (const s of this.streams.values()) {
        while (s.active && s.next < end - 1e-8) {
          if (++this.streamSteps > 4000000)
            throw Error(
              "PCM: limite de 4 milhões de passos de stream. Reduza os loops.",
            );
          const t = s.next,
            idx = s.reverse ? s.length - 1 - s.index : s.index;
          this.capture(s.ch, this.byte(s.bank, s.origin + idx * s.step), t);
          s.next += SR / s.freq;
          if (++s.index >= s.length) {
            this.boundary(s.ch, Math.min(end, s.next));
            if (s.loop) s.index = 0;
            else s.active = false;
          }
        }
      }
    }
    finish() {
      this.advance(this.e.time);
      for (let ch = 0; ch < this.active.length; ch++) this.boundary(ch);
      return this.segments;
    }
  }
  function analyzePCM(seg) {
    const src = seg.data,
      rate = 8000,
      n = Math.floor((src.length * rate) / seg.sampleRate),
      data = new Float32Array(n);
    let mean = 0;
    for (const x of src) mean += x;
    mean /= src.length;
    for (let i = 0; i < n; i++) {
      const a = Math.floor((i * seg.sampleRate) / rate),
        b = Math.min(src.length, Math.floor(((i + 1) * seg.sampleRate) / rate));
      let sum = 0;
      for (let j = a; j < b; j++) sum += src[j] - mean;
      data[i] = sum / Math.max(1, b - a);
    }
    const frames = [],
      hop = 160,
      win = 512;
    let voiced = 0,
      confidence = 0,
      zcr = 0;
    for (let i = 1; i < n; i++) if (data[i] * data[i - 1] < 0) zcr++;
    const stride = Math.max(hop, Math.ceil(n / (1500 * hop)) * hop);
    for (let pos = 0; pos + win <= n; pos += stride) {
      let energy = 0;
      for (let j = 0; j < win; j++) energy += data[pos + j] ** 2;
      energy = Math.sqrt(energy / win);
      let key = null,
        quality = 0;
      if (energy > 0.008) {
        const diff = new Float64Array(150);
        let sum = 0,
          lag = 0;
        for (let tau = 1; tau <= 149; tau++) {
          let d = 0;
          for (let j = 0; j < 256; j++)
            d += (data[pos + j] - data[pos + j + tau]) ** 2;
          sum += d;
          diff[tau] = sum ? (d * tau) / sum : 1;
        }
        for (let tau = 4; tau < 149; tau++)
          if (diff[tau] <= diff[tau - 1] && diff[tau] < diff[tau + 1]) {
            const den = diff[tau - 1] - 2 * diff[tau] + diff[tau + 1],
              minimum =
                diff[tau] -
                (den ? (diff[tau - 1] - diff[tau + 1]) ** 2 / (8 * den) : 0);
            if (minimum < 0.18) {
              lag = tau;
              break;
            }
          }
        if (lag) {
          const a = diff[lag - 1],
            b = diff[lag],
            c = diff[lag + 1],
            den = a - 2 * b + c,
            ref = lag + (den ? (a - c) / (2 * den) : 0);
          key = clamp(Math.round(pitch(rate / ref)), 0, 127);
          quality = 1 - b;
          voiced++;
          confidence += quality;
        }
      }
      frames.push({ pos, key, quality, energy });
    }
    const ratio = voiced / Math.max(1, frames.length),
      keys = frames
        .filter((f) => f.key !== null)
        .map((f) => f.key)
        .sort((a, b) => a - b),
      median = keys[Math.floor(keys.length / 2)] ?? 60;
    const kind = ratio >= 0.55 ? "tonal" : "percussion",
      drum =
        median < 50 && ratio > 0.15
          ? 36
          : zcr / Math.max(1, n) > 0.35
            ? 42
            : 38;
    const notes = [];
    // Short noisy regions receive a trigger, not fictitious melodic pitches.
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      if (i && i + 1 < frames.length && frames[i - 1].key === frames[i + 1].key)
        f.key = frames[i - 1].key;
      if (f.key === null) continue;
      const start = seg.start + (f.pos * SR) / rate,
        end = Math.min(seg.end, start + (stride * SR) / rate);
      const prev = notes.at(-1);
      if (prev && prev.key === f.key && start - prev.end < SR * 0.045)
        prev.end = end;
      else notes.push({ start, end, key: f.key });
    }
    const stable = notes.filter((x) => x.end - x.start >= SR * 0.035);
    if (stable.length) {
      stable[0].start = seg.start;
      stable.at(-1).end = seg.end;
    }
    return {
      kind,
      confidence: voiced ? confidence / voiced : 0,
      voicedRatio: ratio,
      note: median,
      drum,
      notes: stable,
      resolution: stride / rate,
    };
  }
  function mapPCM(song, overrides = {}) {
    const tracks = song.tracks.filter((t) => !t.pcm),
      maxId = tracks.reduce((m, t) => Math.max(m, t.id), -1) + 1,
      groups = new Map();
    for (const seg of song.pcmSegments || []) {
      const o = overrides[seg.id] || {},
        mode = o.mode || "auto";
      if (mode === "ignore") continue;
      const kind = mode === "auto" ? seg.analysis.kind : mode;
      if (!["tonal", "percussion"].includes(kind))
        throw Error("Modo PCM inválido.");
      const key = Number(
        o.key ?? (kind === "tonal" ? seg.analysis.note : seg.analysis.drum),
      );
      if (!Number.isInteger(key) || key < 0 || key > 127)
        throw Error("Nota PCM deve estar entre 0 e 127.");
      const group = seg.chip * 2 + (kind === "percussion" ? 1 : 0);
      let tr = groups.get(group);
      if (!tr) {
        tr = {
          id: maxId + group,
          pcm: true,
          name:
            seg.source +
            " · " +
            (kind === "tonal" ? "Notas inferidas" : "Percussão inferida"),
          drum: kind === "percussion",
          program: 0,
          notes: [],
        };
        groups.set(group, tr);
      }
      const inferred =
          kind === "tonal" && mode === "auto" ? seg.analysis.notes : [],
        ns = inferred.length
          ? inferred
          : [
              {
                start: seg.start,
                end:
                  kind === "percussion"
                    ? Math.min(seg.end, seg.start + SR * 0.12)
                    : seg.end,
                key,
              },
            ];
      for (const n of ns)
        tr.notes.push({
          ...n,
          pcmId: seg.id,
          velocity: 100,
          program: 0,
          points: [{ time: n.start, pitch: n.key, volume: 100, pan: seg.pan }],
        });
    }
    for (const tr of groups.values()) {
      tr.notes.sort((a, b) => a.start - b.start);
      tracks.push(tr);
    }
    return { ...song, tracks };
  }
  function pcmWAV(seg) {
    const data = seg.data,
      out = new Uint8Array(44 + data.length * 2),
      v = new DataView(out.buffer),
      put = (p, s) => {
        for (let i = 0; i < s.length; i++) out[p + i] = s.charCodeAt(i);
      };
    put(0, "RIFF");
    v.setUint32(4, out.length - 8, true);
    put(8, "WAVEfmt ");
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, seg.sampleRate, true);
    v.setUint32(28, seg.sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    put(36, "data");
    v.setUint32(40, data.length * 2, true);
    for (let i = 0; i < data.length; i++)
      v.setInt16(44 + i * 2, Math.round(clamp(data[i], -1, 1) * 32767), true);
    return out;
  }

  const CHIP_HEADERS = [
    ["SN76489", 0x0c],
    ["YM2413", 0x10],
    ["YM2612", 0x2c],
    ["YM2151", 0x30],
    ["SegaPCM", 0x38],
    ["RF5C68", 0x40],
    ["YM2203", 0x44],
    ["YM2608", 0x48],
    ["YM2610", 0x4c],
    ["YM3812", 0x50],
    ["YM3526", 0x54],
    ["Y8950", 0x58],
    ["YMF262", 0x5c],
    ["YMF278B", 0x60],
    ["YMF271", 0x64],
    ["YMZ280B", 0x68],
    ["RF5C164", 0x6c],
    ["PWM", 0x70],
    ["AY8910", 0x74],
    ["Game Boy", 0x80],
    ["NES APU", 0x84],
    ["MultiPCM", 0x88],
    ["uPD7759", 0x8c],
    ["OKIM6258", 0x90],
    ["OKIM6295", 0x98],
    ["K051649", 0x9c],
    ["K054539", 0xa0],
    ["HuC6280", 0xa4],
    ["C140", 0xa8],
    ["K053260", 0xac],
    ["Pokey", 0xb0],
    ["QSound", 0xb4],
    ["SCSP", 0xb8],
    ["WonderSwan", 0xc0],
    ["VSU", 0xc4],
    ["SAA1099", 0xc8],
    ["ES5503", 0xcc],
    ["ES5506", 0xd0],
    ["X1-010", 0xd8],
    ["C352", 0xdc],
    ["GA20", 0xe0],
  ];
  const SUPPORTED = new Set([
    "SN76489",
    "YM2413",
    "YM2612",
    "YM2151",
    "YM2203",
    "YM2608",
    "YM2610",
    "YM3812",
    "YM3526",
    "Y8950",
    "YMF262",
    "AY8910",
    "Game Boy",
    "NES APU",
    "HuC6280",
    "SAA1099",
    "K051649",
    "SegaPCM",
  ]);
  const GM = [
    "Piano acústico",
    "Piano brilhante",
    "Piano elétrico de cauda",
    "Piano honky-tonk",
    "Piano elétrico 1",
    "Piano elétrico 2",
    "Cravo",
    "Clavinete",
    "Celesta",
    "Glockenspiel",
    "Caixa de música",
    "Vibrafone",
    "Marimba",
    "Xilofone",
    "Sinos tubulares",
    "Dulcimer",
    "Órgão drawbar",
    "Órgão percussivo",
    "Órgão rock",
    "Órgão de igreja",
    "Órgão de palhetas",
    "Acordeão",
    "Harmônica",
    "Bandoneon",
    "Violão nylon",
    "Violão aço",
    "Guitarra jazz",
    "Guitarra limpa",
    "Guitarra abafada",
    "Guitarra overdrive",
    "Guitarra distorcida",
    "Harmônicos de guitarra",
    "Baixo acústico",
    "Baixo elétrico dedo",
    "Baixo elétrico palheta",
    "Baixo fretless",
    "Slap bass 1",
    "Slap bass 2",
    "Baixo sintetizado 1",
    "Baixo sintetizado 2",
    "Violino",
    "Viola",
    "Violoncelo",
    "Contrabaixo",
    "Cordas tremolo",
    "Cordas pizzicato",
    "Harpa",
    "Tímpanos",
    "Conjunto de cordas 1",
    "Conjunto de cordas 2",
    "Cordas sintetizadas 1",
    "Cordas sintetizadas 2",
    "Coro Aah",
    "Voz Ooh",
    "Voz sintetizada",
    "Orchestra hit",
    "Trompete",
    "Trombone",
    "Tuba",
    "Trompete com surdina",
    "Trompa",
    "Metais",
    "Metais sintetizados 1",
    "Metais sintetizados 2",
    "Sax soprano",
    "Sax alto",
    "Sax tenor",
    "Sax barítono",
    "Oboé",
    "Corne inglês",
    "Fagote",
    "Clarinete",
    "Flautim",
    "Flauta",
    "Flauta doce",
    "Flauta de Pã",
    "Garrafa soprada",
    "Shakuhachi",
    "Apito",
    "Ocarina",
    "Lead quadrado",
    "Lead dente de serra",
    "Lead calliope",
    "Lead chiff",
    "Lead charang",
    "Lead voz",
    "Lead quintas",
    "Lead baixo + solo",
    "Pad new age",
    "Pad quente",
    "Pad polysynth",
    "Pad coral",
    "Pad bowed",
    "Pad metálico",
    "Pad halo",
    "Pad sweep",
    "FX chuva",
    "FX trilha",
    "FX cristal",
    "FX atmosfera",
    "FX brilho",
    "FX goblins",
    "FX ecos",
    "FX ficção científica",
    "Sitar",
    "Banjo",
    "Shamisen",
    "Koto",
    "Kalimba",
    "Gaita de foles",
    "Rabeca",
    "Shanai",
    "Sino",
    "Agogô",
    "Steel drums",
    "Bloco de madeira",
    "Taiko",
    "Tom melódico",
    "Bateria sintetizada",
    "Prato reverso",
    "Ruído de traste",
    "Ruído de respiração",
    "Mar",
    "Pássaro",
    "Telefone",
    "Helicóptero",
    "Aplausos",
    "Tiro",
  ];
  // Additional register decoders. These infer notes; they do not emulate timbres.
  class HuC {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.name = name;
      this.sel = 0;
      this.master = 0;
      this.r = Array.from({ length: 6 }, () => new Uint8Array(8));
      this.force = Array(6).fill(false);
      this.ts = Array.from({ length: 6 }, (_, i) =>
        e.track(name + " · Onda " + (i + 1), false, 81),
      );
      this.ns = [
        e.track(name + " · Ruído 5", true),
        e.track(name + " · Ruído 6", true),
      ];
    }
    write(a, d) {
      if (a === 0) {
        this.sel = d & 7;
        return;
      }
      if (a === 1) {
        this.master = d;
        return;
      }
      if (a >= 8) {
        if (a === 9 && d & 3)
          this.e.warn("huc-lfo", "HuC6280: LFO de hardware não é transcrito.");
        return;
      }
      if (this.sel >= 6) return;
      const r = this.r[this.sel];
      if (a === 4 && !(r[a] & 128) && d & 128) this.force[this.sel] = true;
      r[a] = d;
      if (a === 4 && d & 64)
        this.e.warn(
          "huc-dda",
          "HuC6280: DDA/PCM direto não é transcrito; as vozes de onda e ruído continuam disponíveis.",
        );
    }
    sync() {
      for (let i = 0; i < 6; i++) {
        const r = this.r[i],
          per = r[2] | ((r[3] & 15) << 8),
          noise = i >= 4 && !!(r[7] & 128),
          left = (this.master >> 4) * (r[5] >> 4),
          right = (this.master & 15) * (r[5] & 15),
          v = ((((r[4] & 31) * 127) / 31) * Math.max(left, right)) / 225,
          pan = left + right ? Math.round((right / (left + right)) * 127) : 64;
        this.e.voice(
          this.ts[i],
          this.clock / (32 * (per || 4096)),
          !!(r[4] & 128) && !(r[4] & 64) && !noise,
          v,
          pan,
          this.force[i],
          81,
        );
        if (i >= 4)
          this.e.voice(
            this.ns[i - 4],
            440,
            !!(r[4] & 128) && noise,
            v,
            pan,
            this.force[i],
            0,
            42,
          );
        this.force[i] = false;
      }
    }
  }
  class SAA {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(32);
      this.ts = Array.from({ length: 6 }, (_, i) =>
        e.track(name + " · Tom " + (i + 1)),
      );
      this.ns = Array.from({ length: 6 }, (_, i) =>
        e.track(name + " · Ruído " + (i + 1), true),
      );
    }
    write(a, d) {
      if (a >= 32) return;
      this.r[a] = d;
      if ((a === 24 || a === 25) && d & 128)
        this.e.warn(
          "saa-envelope",
          "SAA1099: envelopes automáticos são aproximados por volume fixo.",
        );
    }
    sync() {
      for (let i = 0; i < 6; i++) {
        const octave = (this.r[16 + (i >> 1)] >> ((i & 1) * 4)) & 7,
          l = this.r[i] & 15,
          r = this.r[i] >> 4,
          v = (Math.max(l, r) * 127) / 15,
          pan = l + r ? Math.round((r / (l + r)) * 127) : 64,
          on = !!(this.r[28] & 1);
        this.e.voice(
          this.ts[i],
          (this.clock / 512 / (511 - this.r[8 + i])) * 2 ** octave,
          on && !!(this.r[20] & (1 << i)),
          v,
          pan,
        );
        this.e.voice(
          this.ns[i],
          440,
          on && !!(this.r[21] & (1 << i)),
          v,
          pan,
          false,
          0,
          42,
        );
      }
    }
  }
  class SCC {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.freq = new Uint16Array(5);
      this.vol = new Uint8Array(5);
      this.key = 0;
      this.force = 0;
      this.ts = Array.from({ length: 5 }, (_, i) =>
        e.track(name + " · Onda " + (i + 1), false, 81),
      );
    }
    write(port, a, d) {
      if (port === 1) {
        const c = a >> 1;
        if (c < 5)
          this.freq[c] =
            a & 1
              ? (this.freq[c] & 255) | ((d & 15) << 8)
              : (this.freq[c] & 0xf00) | d;
      } else if (port === 2 && a < 5) this.vol[a] = d & 15;
      else if (port === 3) {
        this.force |= ~this.key & d & 31;
        this.key = d & 31;
      } else if (port === 5 && d)
        this.e.warn(
          "scc-test",
          "SCC: modos especiais do registro de teste não são emulados.",
        );
    }
    sync() {
      for (let i = 0; i < 5; i++)
        this.e.voice(
          this.ts[i],
          this.clock / (16 * (this.freq[i] + 1)),
          !!(this.key & (1 << i)) && this.freq[i] > 8,
          (this.vol[i] * 127) / 15,
          64,
          !!(this.force & (1 << i)),
          81,
        );
      this.force = 0;
    }
  }
  class SegaPCM {
    constructor(e, name, clock, inst, config) {
      this.e = e;
      this.clock = clock;
      this.name = name;
      this.inst = inst;
      this.r = new Uint8Array(2048);
      for (let i = 0; i < 16; i++) this.r[0x86 + i * 8] = 1;
      this.addr = new Float64Array(16);
      this.next = e.time;
      this.rom = null;
      this.ranges = [];
      this.missing = false;
      this.shift = config ? config & 255 : 12;
      this.mask = config ? config >>> 16 : 0xf0;
      if (this.shift > 20) throw Error("Bank shift SegaPCM inválido.");
      this.mask &= 0x1fffff >> this.shift;
      for (let i = 0; i < 16; i++) {
        const ch = 2 + inst * 16 + i;
        e.pcm.enabled[ch] = true;
        e.pcm.pan[ch] = 64;
        e.pcm.sources[ch] = name + " · PCM " + (i + 1);
      }
    }
    load(b) {
      if (b.length < 8) throw Error("Bloco ROM SegaPCM truncado.");
      const d = new DataView(b.buffer, b.byteOffset, b.byteLength),
        size = d.getUint32(0, true),
        start = d.getUint32(4, true);
      if (
        !size ||
        size > 64 * 1024 * 1024 ||
        start > size ||
        b.length - 8 > size - start
      )
        throw Error("ROM SegaPCM inválida ou maior que 64 MB.");
      if (!this.rom || this.rom.length !== size) {
        this.rom = new Uint8Array(size);
        this.rom.fill(128);
        this.ranges = [];
      }
      this.rom.set(b.subarray(8), start);
      this.ranges.push([start, start + b.length - 8]);
    }
    write(a, d) {
      a &= 0x7ff;
      const c = (a & 0x7f) >> 3,
        ch = 2 + this.inst * 16 + c;
      if ([2, 3, 0x84, 0x85, 0x86].includes(a - c * 8)) {
        this.e.pcm.boundary(ch);
        if (a - c * 8 === 0x84)
          this.addr[c] = Math.floor(this.addr[c] / 65536) * 65536 + d * 256;
        if (a - c * 8 === 0x85)
          this.addr[c] = d * 65536 + (Math.floor(this.addr[c]) & 0xffff);
      }
      this.r[a] = d;
    }
    sync() {}
    advance(end) {
      const channels = [];
      for (let c = 0; c < 16; c++)
        if (!(this.r[c * 8 + 0x86] & 1)) channels.push(c);
      if (!channels.length) {
        this.next = end;
        return;
      }
      while (this.next < end) {
        const time = this.next;
        this.next += 2;
        for (const c of channels) {
          const p = c * 8,
            r = this.r,
            ch = 2 + this.inst * 16 + c;
          if (r[p + 0x86] & 1) continue;
          const left = r[p + 2] & 127,
            right = r[p + 3] & 127,
            bank = (r[p + 0x86] & this.mask) << this.shift;
          let addr = this.addr[c];
          if ((Math.floor(addr / 65536) & 255) === ((r[p + 6] + 1) & 255)) {
            this.e.pcm.boundary(ch, time);
            if (r[p + 0x86] & 2) {
              r[p + 0x86] |= 1;
              continue;
            }
            addr = (r[p + 5] << 16) | (r[p + 4] << 8);
          }
          const index = bank | (Math.floor(addr) >> 8);
          if (
            !this.rom ||
            index >= this.rom.length ||
            !this.ranges.some((x) => index >= x[0] && index < x[1])
          ) {
            if (!this.missing) {
              this.e.warn(
                "segapcm-rom",
                "SegaPCM: ROM ausente ou região não carregada; trechos indisponíveis ficam silenciosos.",
              );
              this.missing = true;
            }
          } else if (left || right) {
            this.e.pcm.pan[ch] = Math.round((right / (left + right)) * 127);
            const v = Math.round(
              128 + ((this.rom[index] - 128) * Math.max(left, right)) / 127,
            );
            this.e.pcm.capture(ch, v, time);
          }
          this.addr[c] =
            (addr + (((r[p + 7] * this.clock) / 128) * 2) / SR) % 0x1000000;
          r[p + 0x84] = (this.addr[c] >> 8) & 255;
          r[p + 0x85] = (this.addr[c] >> 16) & 255;
        }
      }
    }
  }

  class Engine {
    constructor(options) {
      this.options = options;
      this.time = 0;
      this.tracks = [];
      this.messages = new Map();
      this.events = 0;
      this.commands = 0;
      this.chips = new Map();
    }
    warn(code, message) {
      if (!this.messages.has(code))
        this.messages.set(code, { code, message, count: 0 });
      this.messages.get(code).count++;
    }
    track(name, drum = false, program = 80) {
      const t = {
        id: this.tracks.length,
        name,
        drum,
        program,
        notes: [],
        active: null,
      };
      this.tracks.push(t);
      return t;
    }
    close(t) {
      if (!t.active) return;
      t.active.end = this.time;
      if (t.active.end > t.active.start) t.notes.push(t.active);
      t.active = null;
    }
    voice(
      t,
      hz,
      on,
      vol = 100,
      pan = 64,
      force = false,
      program = t.program,
      drumNote = 42,
    ) {
      const p = t.drum ? drumNote : pitch(hz);
      on = on && Number.isFinite(p) && p >= -0.5 && p < 127.5 && vol > 0;
      if (!on) {
        this.close(t);
        return;
      }
      const key = clamp(Math.round(p), 0, 127),
        v = clamp(Math.round(vol), 1, 127),
        pa = clamp(Math.round(pan), 0, 127);
      let a = t.active;
      const mode = this.options.pitchMode || "bend";
      if (
        a &&
        (force ||
          program !== a.program ||
          (t.drum && key !== a.key) ||
          (mode === "notes" && key !== a.key) ||
          (mode === "bend" && Math.abs(p - a.key) > 24))
      ) {
        this.close(t);
        a = null;
      }
      if (!a) {
        if (++this.events > 500000)
          throw Error(
            "Limite de 500 mil notas atingido. Reduza as repetições.",
          );
        a = {
          start: this.time,
          end: 0,
          key,
          velocity: 100,
          program,
          points: [
            {
              time: this.time,
              pitch: mode === "notes" ? key : p,
              volume: v,
              pan: pa,
            },
          ],
        };
        t.active = a;
      } else {
        const last = a.points[a.points.length - 1],
          q = mode === "notes" ? a.key : p;
        if (
          Math.abs(last.pitch - q) >= 0.012 ||
          last.volume !== v ||
          last.pan !== pa
        ) {
          if (++this.events > 1000000)
            throw Error(
              "Limite de eventos excedido. Tente o modo de notas discretas.",
            );
          a.points.push({ time: this.time, pitch: q, volume: v, pan: pa });
        }
      }
    }
    sync() {
      for (const c of this.chips.values()) c.sync();
    }
    wait(n) {
      if (!n) return;
      this.sync();
      const end = this.time + n;
      if (end > MAX_TIME)
        throw Error("A duração excede 30 minutos. Reduza as repetições.");
      for (const c of this.chips.values()) if (c.advance) c.advance(end);
      let steps = 0;
      while (true) {
        let next = end + 1;
        for (const c of this.chips.values())
          if (c.nextTick !== undefined) next = Math.min(next, c.nextTick);
        if (next > end) break;
        this.time = next;
        for (const c of this.chips.values())
          if (c.nextTick <= next + 1e-7) c.tick();
        this.sync();
        if (++steps > 1000000) throw Error("Excesso de eventos de envelope.");
      }
      if (this.pcm) this.pcm.advance(end);
      this.time = end;
    }
    finish() {
      this.sync();
      for (const t of this.tracks) this.close(t);
      return this.tracks
        .filter((t) => t.notes.length)
        .map(({ active, ...t }) => t);
    }
  }
  class SN {
    constructor(e, name, clock, flags = 0) {
      this.e = e;
      this.clock = clock;
      this.flags = flags;
      this.r = [0, 15, 0, 15, 0, 15, 0, 15];
      this.latch = 0;
      this.stereo = 255;
      this.force = false;
      this.ts = Array.from({ length: 4 }, (_, i) =>
        e.track(name + " · " + (i === 3 ? "Ruído" : "PSG " + (i + 1)), i === 3),
      );
    }
    write(_, d) {
      if (d & 128) {
        this.latch = (d >> 4) & 7;
        this.r[this.latch] = (this.r[this.latch] & 0x3f0) | (d & 15);
      } else if (!(this.latch & 1) && this.latch < 6)
        this.r[this.latch] = (this.r[this.latch] & 15) | ((d & 63) << 4);
      else this.r[this.latch] = d & 15;
      if (this.latch === 6) this.force = true;
    }
    sync() {
      for (let i = 0; i < 4; i++) {
        let n = this.r[i * 2];
        if (!n) n = this.flags & 1 ? 1024 : 1;
        let hz = this.clock / (this.flags & 8 ? 4 : 32) / n;
        const lr =
            ((this.stereo >> (i + 4)) & 1) * 2 + ((this.stereo >> i) & 1),
          v =
            this.r[i * 2 + 1] === 15
              ? 0
              : 127 * Math.pow(10, -this.r[i * 2 + 1] / 10);
        this.e.voice(
          this.ts[i],
          hz,
          !!lr,
          v,
          lr === 2 ? 0 : lr === 1 ? 127 : 64,
          i === 3 && this.force,
          80,
          this.r[6] & 4 ? 42 : 37,
        );
      }
      this.force = false;
    }
  }
  class AY {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(16);
      this.r[7] = 63;
      this.ts = Array.from({ length: 3 }, (_, i) =>
        e.track(name + " · SSG " + (i + 1)),
      );
      this.ns = Array.from({ length: 3 }, (_, i) =>
        e.track(name + " · Ruído " + (i + 1), true),
      );
    }
    write(a, d) {
      if (a < 16) this.r[a] = d;
      if (a >= 11 && a <= 13)
        this.e.warn(
          "ay-envelope",
          "AY/SSG: o envelope automático é aproximado por volume fixo; a forma do envelope não é emulada.",
        );
    }
    sync() {
      for (let i = 0; i < 3; i++) {
        const period = this.r[i * 2] | ((this.r[i * 2 + 1] & 15) << 8),
          v = this.r[8 + i] & 16 ? 100 : ((this.r[8 + i] & 15) * 127) / 15;
        this.e.voice(
          this.ts[i],
          this.clock / 16 / Math.max(1, period),
          !(this.r[7] & (1 << i)),
          v,
        );
        this.e.voice(
          this.ns[i],
          440,
          !(this.r[7] & (8 << i)),
          v,
          64,
          false,
          0,
          42,
        );
      }
    }
  }
  const CARRIERS = [
    [3],
    [3],
    [3],
    [3],
    [1, 3],
    [1, 2, 3],
    [1, 2, 3],
    [0, 1, 2, 3],
  ];
  class OPN {
    constructor(e, name, clock, type) {
      this.e = e;
      this.name = name;
      this.clock = clock;
      this.type = type;
      this.n = type === "YM2203" ? 3 : 6;
      this.r = new Uint8Array(512);
      this.r.fill(0);
      this.on = Array(this.n).fill(false);
      this.force = Array(this.n).fill(false);
      this.ts = Array.from({ length: this.n }, (_, i) =>
        e.track(name + " · FM " + (i + 1), false, 80),
      );
      this.ay =
        type === "YM2612"
          ? null
          : new AY(e, name, clock / (type === "YM2203" ? 4 : 4));
      this.hi = [0, 0];
      this.freq = new Uint16Array(this.n);
    }
    write(a, d) {
      const reg = a & 255,
        port = a >> 8;
      if (this.ay && !port && reg < 16) {
        this.ay.write(reg, d);
        return;
      }
      this.r[a] = d;
      if (reg >= 0xa4 && reg <= 0xa6) this.hi[port] = d & 63;
      if (reg >= 0xa0 && reg <= 0xa2) {
        const ch = port * 3 + reg - 0xa0;
        if (ch < this.n) this.freq[ch] = (this.hi[port] << 8) | d;
      }
      if (!port && reg === 0x28) {
        const ch = (d & 3) + (d & 4 ? 3 : 0);
        if ((d & 3) < 3 && ch < this.n) {
          if (d & 0xf0) this.force[ch] = true;
          this.on[ch] = !!(d & 0xf0);
        }
      }
      if (!port && reg === 0x27 && d & 0xc0)
        this.e.warn(
          "opn-special",
          "FM: o modo especial do canal 3/CSM é aproximado pela frequência principal.",
        );
      if (
        this.type !== "YM2612" &&
        ((port && reg < 0x30) || (!port && reg >= 0x10 && reg < 0x20))
      )
        this.e.warn(
          "adpcm",
          "Ritmos/ADPCM de YM2608/YM2610 não são transcritos.",
        );
      if (reg === 0x22 && d & 8)
        this.e.warn(
          "fm-lfo",
          "LFO de hardware, envelopes e timbres FM não são recriados; só alterações explícitas de frequência e volume.",
        );
      if (this.type === "YM2203" && [0x2d, 0x2e, 0x2f].includes(reg))
        this.e.warn(
          "opn-prescale",
          "Prescaler alternativo do YM2203 não é emulado; confira a afinação.",
        );
    }
    sync() {
      if (this.ay) this.ay.sync();
      for (let i = 0; i < this.n; i++) {
        const port = i >= 3 ? 256 : 0,
          c = i % 3,
          f = this.freq[i] & 2047,
          block = (this.freq[i] >> 11) & 7;
        const hz =
            ((f * this.clock) / (this.type === "YM2203" ? 72 : 144)) *
            Math.pow(2, block - 20),
          alg = this.r[port + 0xb0 + c] & 7;
        let tl = 127;
        for (const s of CARRIERS[alg])
          tl = Math.min(tl, this.r[port + 0x40 + c + [0, 8, 4, 12][s]] & 127);
        const pan = this.r[port + 0xb4 + c] >> 6,
          enabled =
            this.on[i] &&
            !(i === 5 && this.type === "YM2612" && this.r[0x2b] & 128);
        this.e.voice(
          this.ts[i],
          hz,
          enabled && (this.type === "YM2203" || pan !== 0),
          127 * Math.pow(10, (-tl * 0.75) / 20),
          this.type === "YM2203" ? 64 : pan === 2 ? 0 : pan === 1 ? 127 : 64,
          this.force[i],
        );
        this.force[i] = false;
      }
    }
  }
  class OPM {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(256);
      this.on = Array(8).fill(false);
      this.force = Array(8).fill(false);
      this.ts = Array.from({ length: 8 }, (_, i) =>
        e.track(name + " · FM " + (i + 1)),
      );
    }
    write(a, d) {
      this.r[a] = d;
      if (a === 8) {
        const c = d & 7;
        this.on[c] = !!(d & 0x78);
        if (this.on[c]) this.force[c] = true;
      }
    }
    sync() {
      for (let i = 0; i < 8; i++) {
        const kc = this.r[0x28 + i],
          kcmap = [0, 1, 2, 2, 3, 4, 5, 5, 6, 7, 8, 8, 9, 10, 11, 11];
        const p =
          13 +
          ((kc >> 4) & 7) * 12 +
          kcmap[kc & 15] +
          (this.r[0x30 + i] >> 2) / 64;
        const alg = this.r[0x20 + i] & 7;
        let tl = 127;
        for (const s of CARRIERS[alg])
          tl = Math.min(tl, this.r[0x60 + i + [0, 16, 8, 24][s]] & 127);
        const pan = (this.r[0x20 + i] >> 6) & 3;
        this.e.voice(
          this.ts[i],
          440 * Math.pow(2, (p - 69) / 12) * (this.clock / 3579545),
          this.on[i] && pan !== 0,
          127 * Math.pow(10, (-tl * 0.75) / 20),
          pan === 1 ? 0 : pan === 2 ? 127 : 64,
          this.force[i],
        );
        this.force[i] = false;
        if (i === 7 && this.r[0xf] & 128)
          this.e.warn(
            "opm-noise",
            "YM2151: o gerador de ruído do canal 8 é aproximado como nota melódica.",
          );
      }
    }
  }
  class OPLL {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(64);
      this.force = Array(9).fill(false);
      this.ts = Array.from({ length: 9 }, (_, i) =>
        e.track(name + " · FM " + (i + 1)),
      );
      this.ds = Array.from({ length: 5 }, (_, i) =>
        e.track(name + " · Ritmo " + (i + 1), true),
      );
      this.df = 0;
    }
    write(a, d) {
      if (a >= 64) return;
      const old = this.r[a];
      this.r[a] = d;
      if (a >= 0x20 && a <= 0x28 && !(old & 16) && d & 16)
        this.force[a - 0x20] = true;
      if (a === 14) this.df |= ~old & d & 31;
    }
    sync() {
      const programs = [
          80, 40, 24, 0, 73, 71, 68, 56, 16, 60, 11, 6, 72, 33, 32, 48,
        ],
        rhythm = !!(this.r[14] & 32);
      for (let i = 0; i < 9; i++) {
        const hi = this.r[0x20 + i],
          f = this.r[0x10 + i] | ((hi & 1) << 8),
          hz = ((f * this.clock) / 72) * Math.pow(2, ((hi >> 1) & 7) - 19),
          patch = this.r[0x30 + i] >> 4,
          v = 127 * Math.pow(10, (-(this.r[0x30 + i] & 15) * 3) / 20);
        this.e.voice(
          this.ts[i],
          hz,
          !!(hi & 16) && !(rhythm && i >= 6),
          v,
          64,
          this.force[i],
          programs[patch],
        );
        this.force[i] = false;
      }
      const notes = [42, 49, 45, 38, 36],
        regs = [0x37, 0x38, 0x38, 0x37, 0x36],
        high = [true, false, true, false, false];
      for (let i = 0; i < 5; i++) {
        const v =
          127 *
          Math.pow(
            10,
            (-((this.r[regs[i]] >> (high[i] ? 4 : 0)) & 15) * 3) / 20,
          );
        this.e.voice(
          this.ds[i],
          440,
          rhythm && !!(this.r[14] & (1 << i)),
          v,
          64,
          !!(this.df & (1 << i)),
          0,
          notes[i],
        );
      }
      this.df = 0;
    }
  }
  class OPL {
    constructor(e, name, clock, dual) {
      this.e = e;
      this.clock = clock;
      this.dual = dual;
      this.r = new Uint8Array(512);
      this.force = Array(dual ? 18 : 9).fill(false);
      this.ts = this.force.map((_, i) => e.track(name + " · FM " + (i + 1)));
      this.ds = Array.from({ length: 5 }, (_, i) =>
        e.track(name + " · Ritmo " + (i + 1), true),
      );
      this.df = 0;
    }
    write(a, d) {
      const old = this.r[a];
      this.r[a] = d;
      const r = a & 255;
      if (r >= 0xb0 && r <= 0xb8 && !(old & 32) && d & 32)
        this.force[(a >> 8) * 9 + r - 0xb0] = true;
      if (a === 0xbd) this.df |= ~old & d & 31;
      if (a === 0x104 && d)
        this.e.warn(
          "opl4op",
          "OPL3: conexões de quatro operadores são aproximadas como pares de vozes de dois operadores.",
        );
    }
    sync() {
      const offs = [0, 1, 2, 8, 9, 10, 16, 17, 18],
        rhythm = !!(this.r[0xbd] & 32);
      for (let i = 0; i < this.ts.length; i++) {
        const p = i >= 9 ? 256 : 0,
          c = i % 9,
          hi = this.r[p + 0xb0 + c],
          f = this.r[p + 0xa0 + c] | ((hi & 3) << 8),
          hz =
            ((f * this.clock) / (this.dual ? 288 : 72)) *
            Math.pow(2, ((hi >> 2) & 7) - 20),
          alg = this.r[p + 0xc0 + c];
        let tl = this.r[p + 0x43 + offs[c]] & 63;
        if (alg & 1) tl = Math.min(tl, this.r[p + 0x40 + offs[c]] & 63);
        const pan = (alg >> 4) & 3;
        this.e.voice(
          this.ts[i],
          hz,
          !!(hi & 32) && !(rhythm && i >= 6 && i <= 8),
          127 * Math.pow(10, (-tl * 0.75) / 20),
          !this.dual ? 64 : pan === 1 ? 0 : pan === 2 ? 127 : 64,
          this.force[i],
        );
        this.force[i] = false;
      }
      for (let i = 0; i < 5; i++)
        this.e.voice(
          this.ds[i],
          440,
          rhythm && !!(this.r[0xbd] & (1 << i)),
          100,
          64,
          !!(this.df & (1 << i)),
          0,
          [42, 49, 45, 38, 36][i],
        );
      this.df = 0;
    }
  }
  class GB {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(48);
      this.on = [false, false, false, false];
      this.len = [0, 0, 0, 0];
      this.env = [0, 0, 0, 0];
      this.envTick = [0, 0, 0, 0];
      this.force = [false, false, false, false];
      this.ts = [
        e.track(name + " · Pulso 1"),
        e.track(name + " · Pulso 2"),
        e.track(name + " · Onda", false, 81),
        e.track(name + " · Ruído", true),
      ];
      this.tickNo = 0;
      this.nextTick = e.time + SR / 256;
    }
    write(a, d) {
      if (a >= 48) return;
      this.r[a] = d;
      if (a === 0x16 && !(d & 128)) {
        this.on.fill(false);
        return;
      }
      const bases = [0, 5, 10, 15];
      for (let i = 0; i < 4; i++) {
        const b = bases[i];
        if (a === b + 1)
          this.len[i] = (i === 2 ? 256 : 64) - (d & (i === 2 ? 255 : 63));
        if (i !== 2 && a === b + 2 && !(d & 0xf8)) this.on[i] = false;
        if (i === 2 && a === 10 && !(d & 128)) this.on[i] = false;
        if (a === b + 4 && d & 128) {
          this.on[i] =
            i === 2 ? !!(this.r[10] & 128) : !!(this.r[b + 2] & 0xf8);
          this.force[i] = true;
          if (!this.len[i]) this.len[i] = i === 2 ? 256 : 64;
          this.env[i] = this.r[b + 2] >> 4;
          this.envTick[i] = 0;
        }
      }
      if (a === 0 && d & 0x77)
        this.e.warn(
          "gb-sweep",
          "Game Boy: sweep de frequência automático não é emulado. Length/envelope usam relógio aproximado.",
        );
    }
    tick() {
      this.tickNo++;
      for (let i = 0; i < 4; i++) {
        const b = [0, 5, 10, 15][i];
        if (this.r[b + 4] & 64 && this.len[i] > 0 && --this.len[i] === 0)
          this.on[i] = false;
        if (i !== 2 && this.tickNo % 4 === 0) {
          const env = this.r[b + 2],
            period = env & 7;
          if (period && ++this.envTick[i] >= period) {
            this.envTick[i] = 0;
            this.env[i] = clamp(this.env[i] + (env & 8 ? 1 : -1), 0, 15);
          }
        }
      }
      this.nextTick += SR / 256;
    }
    sync() {
      for (let i = 0; i < 4; i++) {
        const b = [0, 5, 10, 15][i],
          per = this.r[b + 3] | ((this.r[b + 4] & 7) << 8);
        const lr =
          ((this.r[0x15] >> (i + 4)) & 1) * 2 + ((this.r[0x15] >> i) & 1);
        let v =
          i === 2
            ? [0, 127, 64, 32][(this.r[12] >> 5) & 3]
            : (this.env[i] * 127) / 15;
        this.e.voice(
          this.ts[i],
          this.clock / (i === 2 ? 64 : 32) / (2048 - per),
          this.on[i] && !!lr && !!(this.r[0x16] & 128),
          v,
          lr === 2 ? 0 : lr === 1 ? 127 : 64,
          this.force[i],
          i === 2 ? 81 : 80,
          42,
        );
        this.force[i] = false;
      }
    }
  }
  const NES_LENGTH = [
    10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24,
    18, 48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
  ];
  class NES {
    constructor(e, name, clock) {
      this.e = e;
      this.clock = clock;
      this.r = new Uint8Array(128);
      this.len = [0, 0, 0, 0];
      this.env = [0, 0, 0, 0];
      this.div = [0, 0, 0, 0];
      this.force = [false, false, false, false];
      this.linear = 0;
      this.reload = false;
      this.tickNo = 0;
      this.nextTick = e.time + SR / (clock < 1700000 ? 200 : 240);
      this.tickRate = clock < 1700000 ? 200 : 240;
      this.ts = [
        e.track(name + " · Pulso 1"),
        e.track(name + " · Pulso 2"),
        e.track(name + " · Triângulo", false, 80),
        e.track(name + " · Ruído", true),
      ];
    }
    write(a, d) {
      if (a >= 128) return;
      this.r[a] = d;
      if (a === 0x15) {
        for (let i = 0; i < 4; i++) if (!(d & (1 << i))) this.len[i] = 0;
        if (d & 16)
          this.e.warn("nes-dmc", "NES: samples DMC não são transcritos.");
      }
      if ([3, 7, 11, 15].includes(a)) {
        const i = a >> 2;
        if (this.r[0x15] & (1 << i)) this.len[i] = NES_LENGTH[d >> 3];
        this.force[i] = true;
        this.env[i] = 15;
        this.div[i] = 0;
        if (i === 2) {
          this.reload = true;
          this.linear = this.r[8] & 127;
        }
      }
      if ([1, 5].includes(a) && d & 128 && d & 7)
        this.e.warn(
          "nes-sweep",
          "NES: sweep automático não é emulado. Length, envelope e contador linear usam relógio aproximado.",
        );
      if (a >= 0x10 && a <= 0x13)
        this.e.warn("nes-dmc", "NES: samples DMC não são transcritos.");
      if (a === 0x17 && d & 128)
        this.e.warn(
          "nes-frame",
          "NES: frame sequencer de 5 etapas é aproximado pelo relógio de 4 etapas.",
        );
      if (a >= 0x20)
        this.e.warn("nes-fds", "NES FDS: áudio de expansão não é transcrito.");
    }
    tick() {
      this.tickNo++;
      for (let i = 0; i < 4; i++) {
        const ctl = this.r[i * 4],
          halt = i === 2 ? !!(ctl & 128) : !!(ctl & 32);
        if (this.tickNo % 2 === 0 && !halt && this.len[i]) this.len[i]--;
        if (i !== 2) {
          if (this.div[i]++ >= (ctl & 15)) {
            this.div[i] = 0;
            if (this.env[i] > 0) this.env[i]--;
            else if (ctl & 32) this.env[i] = 15;
          }
        }
      }
      if (this.reload) this.linear = this.r[8] & 127;
      else if (this.linear) this.linear--;
      if (!(this.r[8] & 128)) this.reload = false;
      this.nextTick += SR / this.tickRate;
    }
    sync() {
      for (let i = 0; i < 4; i++) {
        const b = i * 4,
          per = this.r[b + 2] | ((this.r[b + 3] & 7) << 8);
        const vol =
          i === 2
            ? 100
            : ((this.r[b] & 16 ? this.r[b] & 15 : this.env[i]) * 127) / 15;
        const gate =
          this.len[i] > 0 &&
          (i === 3 || (i === 2 ? per > 1 && this.linear > 0 : per >= 8));
        this.e.voice(
          this.ts[i],
          this.clock / (i === 2 ? 32 : 16) / (per + 1),
          gate,
          vol,
          64,
          this.force[i],
          80,
          42,
        );
        this.force[i] = false;
      }
    }
  }
  function parseVGM(bytes, options = {}) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 64)
      throw Error("Arquivo curto demais para conter um cabeçalho VGM.");
    if (b.length > MAX_BYTES)
      throw Error("Arquivo descompactado maior que 128 MB.");
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u32 = (o) => dv.getUint32(o, true),
      u16 = (o) => dv.getUint16(o, true);
    if (String.fromCharCode(...b.slice(0, 4)) !== "Vgm ")
      throw Error(
        "Assinatura VGM inválida. Selecione uma música .vgm, .vgz ou .gym.",
      );
    const version = u32(8);
    if (version < 0x100 || version > 0x172)
      throw Error("Versão VGM não suportada: 0x" + version.toString(16));
    const e = new Engine(options),
      data = version >= 0x150 ? (u32(0x34) ? 0x34 + u32(0x34) : 0x40) : 0x40;
    const eof = u32(4) ? u32(4) + 4 : b.length;
    if (eof > b.length)
      throw Error(
        "VGM truncado: o cabeçalho declara mais bytes que o arquivo contém.",
      );
    if (data < 64 || data >= eof)
      throw Error("Offset de início dos comandos inválido.");
    if (eof < b.length)
      e.warn(
        "trailing",
        "Há bytes depois do fim declarado; eles não entram na conversão.",
      );
    let headerEnd = data;
    const hu = (o) => (o + 4 <= headerEnd ? u32(o) : 0);
    if (data >= 0xc0 && version >= 0x170 && hu(0xbc)) {
      headerEnd = Math.min(headerEnd, 0xbc + hu(0xbc));
      e.warn(
        "extra-header",
        "Cabeçalho extra presente: clocks/volumes individuais extras não são aplicados.",
      );
    }
    const clocks = {};
    for (const [n, o] of CHIP_HEADERS) {
      let raw = hu(o);
      if (version < 0x110 && (o === 0x2c || o === 0x30)) raw = hu(0x10);
      if (raw & 0x3fffffff)
        clocks[n] = {
          hz: raw & 0x3fffffff,
          dual: !!(raw & 0x40000000),
          variant: !!(raw & 0x80000000),
        };
    }
    const gd = hu(0x14) ? hu(0x14) + 0x14 : 0,
      meta = {};
    let streamEnd = eof;
    if (gd) {
      if (
        gd < data ||
        gd + 12 > eof ||
        String.fromCharCode(...b.slice(gd, gd + 4)) !== "Gd3 "
      ) {
        e.warn("gd3", "A etiqueta GD3 é inválida; metadados ignorados.");
      } else {
        streamEnd = gd;
        const len = u32(gd + 8);
        if (len % 2 || gd + 12 + len > eof)
          e.warn("gd3", "Etiqueta GD3 truncada; metadados ignorados.");
        else if (len > 1048576)
          e.warn(
            "gd3-size",
            "Etiqueta GD3 maior que 1 MB; metadados ignorados.",
          );
        else {
          const vals = new TextDecoder("utf-16le")
            .decode(b.slice(gd + 12, gd + 12 + len))
            .split("\0");
          [
            "title",
            "titleJP",
            "game",
            "gameJP",
            "system",
            "systemJP",
            "author",
            "authorJP",
            "date",
            "ripper",
            "notes",
          ].forEach((k, i) => (meta[k] = (vals[i] || "").slice(0, 8192)));
        }
      }
    }
    let loop = hu(0x1c) ? hu(0x1c) + 0x1c : 0;
    if (loop && (loop < data || loop >= streamEnd))
      throw Error("Offset de loop fora da área de comandos.");
    const requested = Number(options.loops ?? 1);
    if (!Number.isInteger(requested) || requested < 1 || requested > 8)
      throw Error("Repetições devem ser de 1 a 8.");
    const fallbacks = {
      SN76489: 3579545,
      YM2413: 3579545,
      YM2612: 7670454,
      YM2151: 3579545,
      YM2203: 4000000,
      YM2608: 8000000,
      YM2610: 8000000,
      YM3812: 3579545,
      YM3526: 3579545,
      Y8950: 3579545,
      YMF262: 14318180,
      AY8910: 1789772,
      "Game Boy": 4194304,
      "NES APU": 1789772,
      HuC6280: 3579545,
      SAA1099: 8000000,
      K051649: 1789773,
      SegaPCM: 4000000,
    };
    function chip(n, inst = 0) {
      const id = n + "/" + inst;
      if (!e.chips.has(id)) {
        let clk = clocks[n]?.hz;
        if (!clk) {
          clk = fallbacks[n];
          e.warn(
            "clock-" + n,
            n + ": clock ausente; usado valor típico. Confira a afinação.",
          );
        }
        const name = n + (inst ? " #2" : "");
        let c;
        if (n === "SN76489") {
          c = new SN(e, name, clk, headerEnd > 0x2b ? b[0x2b] : 0);
          if (clocks[n]?.variant)
            e.warn(
              "t6w28",
              "T6W28 é tratado como dois PSG independentes; a combinação estéreo específica não é emulada.",
            );
        } else if (n === "HuC6280") c = new HuC(e, name, clk);
        else if (n === "SAA1099") c = new SAA(e, name, clk);
        else if (n === "K051649") c = new SCC(e, name, clk);
        else if (n === "SegaPCM") c = new SegaPCM(e, name, clk, inst, hu(0x3c));
        else if (n === "AY8910") c = new AY(e, name, clk);
        else if (n === "YM2413") c = new OPLL(e, name, clk);
        else if (n === "YM2151") c = new OPM(e, name, clk);
        else if (n === "Game Boy") c = new GB(e, name, clk);
        else if (n === "NES APU") c = new NES(e, name, clk);
        else if (["YM3812", "YM3526", "Y8950", "YMF262"].includes(n))
          c = new OPL(e, name, clk, n === "YMF262");
        else c = new OPN(e, name, clk, n);
        e.chips.set(id, c);
      }
      return e.chips.get(id);
    }
    e.pcm = new PCM(e);
    const opnMap = {
      0x51: ["YM2413", 0],
      0x52: ["YM2612", 0],
      0x53: ["YM2612", 1],
      0x54: ["YM2151", 0],
      0x55: ["YM2203", 0],
      0x56: ["YM2608", 0],
      0x57: ["YM2608", 1],
      0x58: ["YM2610", 0],
      0x59: ["YM2610", 1],
      0x5a: ["YM3812", 0],
      0x5b: ["YM3526", 0],
      0x5c: ["Y8950", 0],
      0x5e: ["YMF262", 0],
      0x5f: ["YMF262", 1],
    };
    const unsupported = {
      0x5d: "YMZ280B",
      0xb0: "RF5C68",
      0xb1: "RF5C164",
      0xb2: "PWM",
      0xb5: "MultiPCM",
      0xb6: "uPD7759",
      0xb7: "OKIM6258",
      0xb8: "OKIM6295",
      0xb9: "HuC6280",
      0xba: "K053260",
      0xbb: "Pokey",
      0xbc: "WonderSwan",
      0xbd: "SAA1099",
      0xbe: "ES5506",
      0xbf: "GA20",
      0xc0: "SegaPCM",
      0xc1: "RF5C68",
      0xc2: "RF5C164",
      0xc3: "MultiPCM",
      0xc4: "QSound",
      0xc5: "SCSP",
      0xc6: "WonderSwan",
      0xc7: "VSU",
      0xc8: "X1-010",
      0xd0: "YMF278B",
      0xd1: "YMF271",
      0xd2: "K051649",
      0xd3: "K054539",
      0xd4: "C140",
      0xd5: "ES5503",
      0xd6: "ES5506",
      0xe1: "C352",
    };
    let p = data,
      ended = false,
      loopTime = null,
      loopEnd = null,
      pass = 1,
      baseSamples = 0;
    let wait62 = 735,
      wait63 = 882;
    const markers = [];
    const need = (n) => {
      if (p + n > streamEnd)
        throw Error(
          "Comando ou bloco truncado em 0x" + (p - 1).toString(16) + ".",
        );
    };
    while (p < streamEnd) {
      if (++e.commands > 12000000)
        throw Error("Limite de 12 milhões de comandos atingido.");
      if (p === loop && pass === 1) {
        loopTime = e.time;
        markers.push({ time: e.time, name: "loopStart" });
      }
      const at = p,
        cmd = b[p++];
      if (cmd === 0x66) {
        e.sync();
        if (pass === 1) {
          baseSamples = e.time;
          loopEnd = e.time;
          if (loop) {
            if (loopTime === null)
              throw Error("O loop não aponta para o início de um comando.");
            markers.push({ time: e.time, name: "loopEnd" });
          }
        }
        if (loop && pass < requested) {
          if (e.time <= loopTime)
            throw Error("Loop sem duração: não pode ser repetido.");
          pass++;
          markers.push({ time: e.time, name: "loop " + pass });
          p = loop;
          continue;
        }
        ended = true;
        break;
      }
      if (cmd === 0x61) {
        need(2);
        const n = u16(p);
        p += 2;
        e.wait(n);
        continue;
      }
      if (cmd === 0x62 || cmd === 0x63) {
        e.wait(cmd === 0x62 ? wait62 : wait63);
        continue;
      }
      if (cmd === 0x64) {
        need(3);
        const cc = b[p],
          n = u16(p + 1);
        p += 3;
        if (cc === 0x62) wait62 = n;
        else if (cc === 0x63) wait63 = n;
        else throw Error("Comando 0x64 com destino inválido.");
        continue;
      }
      if (cmd >= 0x70 && cmd <= 0x7f) {
        e.wait((cmd & 15) + 1);
        continue;
      }
      if (cmd >= 0x80 && cmd <= 0x8f) {
        e.pcm.legacy();
        e.wait(cmd & 15);
        continue;
      }
      if (cmd === 0x67) {
        need(6);
        if (b[p] !== 0x66) throw Error("Marcador de bloco 0x67 inválido.");
        const size = u32(p + 2) & 0x7fffffff;
        need(6 + size);
        if (b[p + 1] === 0x80)
          chip("SegaPCM", u32(p + 2) >>> 31).load(
            b.subarray(p + 6, p + 6 + size),
          );
        else e.pcm.block(b[p + 1], b.subarray(p + 6, p + 6 + size), at);
        p += 6 + size;
        continue;
      }
      if (cmd === 0x68) {
        need(11);
        if (b[p] !== 0x66) throw Error("Marcador de cópia PCM inválido.");
        p += 11;
        e.warn(
          "pcm-ram",
          "Cópias PCM para RAM de outros chips não são transcritas.",
        );
        continue;
      }
      if (cmd >= 0x90 && cmd <= 0x95) {
        const len = [4, 4, 5, 10, 1, 4][cmd - 0x90];
        need(len);
        e.pcm.command(cmd, b.subarray(p, p + len));
        p += len;
        continue;
      }
      if (cmd === 0xe0) {
        need(4);
        e.pcm.boundary(0);
        e.pcm.cursor = u32(p);
        p += 4;
        continue;
      }
      if ([0x30, 0x3f, 0x4f, 0x50].includes(cmd)) {
        need(1);
        const c = chip("SN76489", cmd < 0x40 ? 1 : 0),
          d = b[p++];
        if (cmd === 0x3f || cmd === 0x4f) c.stereo = d;
        else c.write(0, d);
        continue;
      }
      const mapped =
        cmd >= 0xa1 && cmd <= 0xaf ? opnMap[cmd - 0x50] : opnMap[cmd];
      if (mapped) {
        need(2);
        if (mapped[0] === "YM2612")
          e.pcm.register(cmd >= 0xa1 ? 1 : 0, mapped[1], b[p], b[p + 1]);
        chip(mapped[0], cmd >= 0xa1 ? 1 : 0).write(
          mapped[1] * 256 + b[p],
          b[p + 1],
        );
        if (mapped[0] === "Y8950" && b[p] >= 7 && b[p] <= 0x12)
          e.warn("y8950-adpcm", "Y8950: a seção ADPCM não é transcrita.");
        p += 2;
        continue;
      }
      if (cmd === 0xb9 || cmd === 0xbd) {
        need(2);
        chip(cmd === 0xb9 ? "HuC6280" : "SAA1099", b[p] >> 7).write(
          b[p] & 127,
          b[p + 1],
        );
        p += 2;
        continue;
      }
      if (cmd === 0xd2) {
        need(3);
        chip("K051649", b[p] >> 7).write(b[p] & 127, b[p + 1], b[p + 2]);
        p += 3;
        continue;
      }
      if (cmd === 0xc0) {
        need(3);
        const a = u16(p);
        chip("SegaPCM", a >> 15).write(a & 0x7fff, b[p + 2]);
        p += 3;
        continue;
      }
      if ([0xa0, 0xb3, 0xb4].includes(cmd)) {
        need(2);
        chip(
          cmd === 0xa0 ? "AY8910" : cmd === 0xb3 ? "Game Boy" : "NES APU",
          b[p] >> 7,
        ).write(b[p] & 127, b[p + 1]);
        p += 2;
        continue;
      }
      let len =
        cmd >= 0x30 && cmd <= 0x3f
          ? 1
          : cmd >= 0x40 && cmd <= 0x4e
            ? version <= 0x160
              ? 1
              : 2
            : cmd >= 0x51 && cmd <= 0x5f
              ? 2
              : cmd >= 0xa0 && cmd <= 0xbf
                ? 2
                : cmd >= 0xc0 && cmd <= 0xdf
                  ? 3
                  : cmd >= 0xe1
                    ? 4
                    : 0;
      if (!len)
        throw Error(
          "Comando desconhecido 0x" +
            cmd.toString(16) +
            " em 0x" +
            at.toString(16) +
            ". Conversão interrompida para evitar MIDI incorreto.",
        );
      need(len);
      p += len;
      const type = unsupported[cmd] || "0x" + cmd.toString(16);
      e.warn(
        "unsupported-" + type,
        type +
          ": comandos reconhecidos, mas áudio não transcrito nesta versão.",
      );
    }
    if (!ended)
      throw Error(
        "Falta o comando de encerramento 0x66; o arquivo pode estar truncado.",
      );
    if (hu(0x18) && hu(0x18) !== baseSamples)
      e.warn(
        "duration",
        "A duração declarada difere da soma dos comandos. Foi usado o tempo real dos comandos.",
      );
    if (loop && hu(0x20) && hu(0x20) !== loopEnd - loopTime)
      e.warn(
        "loop-duration",
        "A duração declarada do loop diverge dos comandos; usado o loop real.",
      );
    const tracks = e.finish(),
      pcmSegments = e.pcm.finish();
    if (pcmSegments.length)
      e.warn(
        "pcm-inference",
        "PCM/DAC: notas e percussão inferidas do áudio, com precisão variável. Revise cada trecho; MIDI não incorpora o sample.",
      );
    if (!tracks.length && !pcmSegments.length)
      e.warn(
        "no-notes",
        "Nenhuma nota compatível foi encontrada. Verifique os chips e os avisos.",
      );
    return mapPCM({
      pcmSegments,
      format: "VGM",
      version: version.toString(16).replace(/^(\d)(.*)$/, "$1.$2"),
      metadata: meta,
      clocks,
      tracks,
      duration: e.time / SR,
      samples: e.time,
      loopStart: loopTime,
      loopEnd,
      passes: pass,
      markers,
      warnings: [...e.messages.values()],
      commands: e.commands,
      sourceBytes: b.length,
    });
  }
  async function decompress(data) {
    let b = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (b.length > 64 * 1024 * 1024)
      throw Error("Limite de entrada: 64 MB por arquivo.");
    if (b[0] !== 31 || b[1] !== 139) return b;
    if (typeof DecompressionStream === "undefined")
      throw Error(
        "Este navegador não oferece descompactação GZIP. Use Chrome/Edge/Firefox recente ou um VGM descompactado.",
      );
    try {
      const reader = new Blob([b])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"))
          .getReader(),
        parts = [];
      let size = 0;
      while (true) {
        const v = await reader.read();
        if (v.done) break;
        size += v.value.length;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw Error("Arquivo descompactado maior que 128 MB.");
        }
        parts.push(v.value);
      }
      const out = new Uint8Array(size);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      return out;
    } catch (err) {
      throw Error("Não foi possível descompactar o GZIP: " + err.message);
    }
  }
  function gymToVGM(b, rate = 60) {
    if (![50, 60].includes(rate))
      throw Error("Frequência GYM deve ser 50 ou 60 Hz.");
    let p = 0;
    const h = new Uint8Array(64),
      d = new DataView(h.buffer);
    h.set([86, 103, 109, 32]);
    d.setUint32(8, 0x150, true);
    d.setUint32(12, 3579545, true);
    d.setUint32(0x2c, 7670454, true);
    d.setUint32(0x34, 12, true);
    let metadata = {};
    if (String.fromCharCode(...b.slice(0, 4)) === "GYMX") {
      if (b.length < 428) throw Error("Cabeçalho GYMX truncado.");
      const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (v.getUint32(424, true))
        throw Error(
          "GYMX com compressão interna não é suportado. Descompacte-o primeiro.",
        );
      const text = (o, n) =>
        new TextDecoder("windows-1252")
          .decode(b.slice(o, o + n))
          .split("\0")[0];
      metadata = {
        title: text(4, 32),
        game: text(36, 32),
        author: text(100, 32),
        notes: text(164, 256),
      };
      p = 428;
    }
    const out = new Uint8Array(Math.min(MAX_BYTES, b.length * 2 + 1));
    let outAt = 0;
    const emit = (...v) => {
      if (outAt + v.length > out.length) throw Error("GYM excede o limite.");
      out.set(v, outAt);
      outAt += v.length;
    };
    const need = (n) => {
      if (p + n > b.length) throw Error("GYM truncado.");
    };
    let frames = 0;
    while (p < b.length) {
      const c = b[p++];
      if (c === 0) {
        emit(rate === 50 ? 0x63 : 0x62);
        frames++;
      } else if (c === 1 || c === 2) {
        need(2);
        emit(c === 1 ? 0x52 : 0x53, b[p++], b[p++]);
      } else if (c === 3) {
        need(1);
        emit(0x50, b[p++]);
      } else throw Error("Comando GYM inválido: " + c);
    }
    emit(0x66);
    const bytes = new Uint8Array(64 + outAt);
    bytes.set(h);
    bytes.set(out.subarray(0, outAt), 64);
    new DataView(bytes.buffer).setUint32(4, bytes.length - 4, true);
    new DataView(bytes.buffer).setUint32(
      0x18,
      frames * (rate === 50 ? 882 : 735),
      true,
    );
    return { bytes, metadata };
  }
  async function decode(data, name = "", options = {}) {
    const b = await decompress(data);
    if (
      /\.gym$/i.test(name) ||
      String.fromCharCode(...b.slice(0, 4)) === "GYMX"
    ) {
      const gym = gymToVGM(b, Number(options.gymRate || 60)),
        r = parseVGM(gym.bytes, options);
      r.format = "GYM";
      r.metadata = gym.metadata;
      r.warnings.push({
        code: "gym-timing",
        message:
          "GYM não informa o clock/região com precisão. Foi aplicada a taxa escolhida; loops do cabeçalho GYMX não são expandidos.",
        count: 1,
      });
      return r;
    }
    return parseVGM(b, options);
  }
  const enc = new TextEncoder();
  const be16 = (n) => [(n >>> 8) & 255, n & 255],
    be32 = (n) => [
      (n >>> 24) & 255,
      (n >>> 16) & 255,
      (n >>> 8) & 255,
      n & 255,
    ];
  function vlq(n) {
    n = Math.round(n);
    if (!Number.isFinite(n) || n < 0 || n > 0xfffffff)
      throw Error("Intervalo MIDI fora do limite.");
    const a = [n & 127];
    while (n >= 128) {
      n = Math.floor(n / 128);
      a.unshift((n & 127) | 128);
    }
    return a;
  }
  function metaEvent(type, str) {
    const b = typeof str === "string" ? enc.encode(str.slice(0, 8192)) : str;
    return [255, type, ...vlq(b.length), ...b];
  }
  function chunk(name, bytes) {
    const out = new Uint8Array(8 + bytes.length);
    out.set(enc.encode(name));
    out.set(be32(bytes.length), 4);
    out.set(bytes, 8);
    return out;
  }
  function trackBytes(events, endTick) {
    events.sort((a, b) => a.tick - b.tick || a.order - b.order);
    const out = [];
    let tick = 0;
    for (const e of events) {
      out.push(...vlq(e.tick - tick), ...e.data);
      tick = e.tick;
    }
    out.push(...vlq(Math.max(tick, endTick) - tick), 255, 47, 0);
    return chunk("MTrk", out);
  }
  function exportMIDI(song, options = {}, settings = {}) {
    const bpm = Number(options.bpm ?? 120),
      ppq = 960,
      transpose = Number(options.transpose || 0);
    if (!Number.isFinite(bpm) || bpm < 20 || bpm > 300)
      throw Error("O BPM deve estar entre 20 e 300.");
    if (!Number.isInteger(transpose) || Math.abs(transpose) > 48)
      throw Error("Transposição deve ser um inteiro de −48 a 48.");
    const tempo = Math.round(60000000 / bpm),
      tick = (s) => Math.round((((s / SR) * 1000000) / tempo) * ppq),
      endTick = tick(song.samples),
      events = [],
      add = (time, data, order = 2) =>
        events.push({ tick: tick(time), order, data });
    add(0, metaEvent(3, song.metadata.title || "VGM2MID Web"));
    add(
      0,
      metaEvent(0x51, [(tempo >> 16) & 255, (tempo >> 8) & 255, tempo & 255]),
    );
    add(0, metaEvent(0x58, [4, 2, 24, 8]));
    if (song.metadata.game) add(0, metaEvent(1, "Game: " + song.metadata.game));
    if (song.metadata.author)
      add(0, metaEvent(1, "Author: " + song.metadata.author));
    add(0, metaEvent(1, "Transcricao aproximada · VGM2MID Web 3.0"));
    for (const m of song.markers) add(m.time, metaEvent(6, m.name));
    const chunks = [trackBytes(events, endTick)];
    let melodicIndex = 0,
      drumIndex = 0;
    const ports = new Set();
    for (const tr of song.tracks) {
      const setting = settings[tr.id] || {};
      if (setting.enabled === false) continue;
      const isDrum =
        setting.sfPreset >= 0 ? Number(setting.bank ?? 0) === 128 : tr.drum;
      const port = isDrum ? drumIndex++ : Math.floor(melodicIndex / 15),
        slot = melodicIndex % 15,
        channel = isDrum ? 9 : slot >= 9 ? slot + 1 : slot;
      if (!isDrum) melodicIndex++;
      ports.add(port);
      if (port > 127) throw Error("Quantidade de portas MIDI excedida.");
      const bank = Number(setting.bank ?? 0);
      if (!Number.isInteger(bank) || bank < 0 || bank > 16383)
        throw Error("Banco MIDI inválido em " + tr.name);
      const vol = Number(setting.volume ?? 100),
        st = Number(setting.transpose ?? 0),
        pr = Number(setting.program ?? -1);
      if (
        !Number.isInteger(vol) ||
        vol < 0 ||
        vol > 127 ||
        !Number.isInteger(st) ||
        Math.abs(st) > 48 ||
        !Number.isInteger(pr) ||
        pr < -1 ||
        pr > 127
      )
        throw Error("Ajuste inválido em " + tr.name);
      const es = [],
        push = (time, data, order = 2) =>
          es.push({ tick: tick(time), data, order });
      push(0, metaEvent(3, tr.name));
      push(0, metaEvent(0x21, [port]));
      push(0, [
        0xb0 | channel,
        7,
        clamp(Math.round(Number(setting.volume ?? 100)), 0, 127),
      ]);
      if (!isDrum) {
        for (const pair of [
          [101, 0],
          [100, 0],
          [6, 24],
          [38, 0],
          [101, 127],
          [100, 127],
        ])
          push(0, [0xb0 | channel, ...pair]);
      }
      if (setting.bank !== undefined) {
        push(0, [0xb0 | channel, 0, bank >> 7]);
        push(0, [0xb0 | channel, 32, bank & 127]);
      }
      let prog = -1;
      const shift = transpose + Number(setting.transpose || 0),
        custom =
          setting.program !== undefined && Number(setting.program) >= 0
            ? clamp(Number(setting.program), 0, 127)
            : null;
      const notes = tr.notes.filter(
        (n, i) =>
          i === tr.notes.length - 1 ||
          tick(tr.notes[i + 1].start) > tick(n.start),
      );
      for (let ni = 0; ni < notes.length; ni++) {
        const n = notes[ni],
          key = n.key + (tr.drum ? 0 : shift);
        if (key < 0 || key > 127)
          throw Error(
            tr.name +
              ": a transposição colocaria notas fora de 0–127. Reduza o valor.",
          );
        const np = custom ?? n.program;
        if ((!tr.drum || setting.sfPreset >= 0) && np !== prog) {
          push(n.start, [0xc0 | channel, np]);
          prog = np;
        }
        for (const pt of n.points) {
          if (pt.time >= n.end) continue;
          if (!isDrum) {
            const bend = clamp(
              Math.round(8192 + ((pt.pitch - n.key) * 8192) / 24),
              0,
              16383,
            );
            push(pt.time, [0xe0 | channel, bend & 127, bend >> 7]);
          }
          push(pt.time, [0xb0 | channel, 11, pt.volume]);
          push(pt.time, [0xb0 | channel, 10, pt.pan]);
        }
        push(n.start, [0x90 | channel, key, n.velocity], 3);
        const st = tick(n.start),
          et = Math.max(
            st + 1,
            Math.min(
              tick(n.end),
              ni + 1 < notes.length ? tick(notes[ni + 1].start) : Infinity,
            ),
          );
        es.push({ tick: et, order: 1, data: [0x80 | channel, key, 0] });
      }
      chunks.push(trackBytes(es, endTick));
    }
    if (chunks.length === 1)
      throw Error("Não há pistas ativas com notas para exportar.");
    const header = chunk(
        "MThd",
        new Uint8Array([...be16(1), ...be16(chunks.length), ...be16(ppq)]),
      ),
      out = new Uint8Array(
        header.length + chunks.reduce((s, c) => s + c.length, 0),
      );
    out.set(header);
    let at = header.length;
    for (const c of chunks) {
      out.set(c, at);
      at += c.length;
    }
    return { bytes: out, ports: ports.size, tracks: chunks.length - 1 };
  }
  function demoVGM() {
    const h = new Uint8Array(64),
      dv = new DataView(h.buffer);
    h.set([86, 103, 109, 32]);
    dv.setUint32(8, 0x150, true);
    dv.setUint32(12, 3579545, true);
    dv.setUint32(0x34, 12, true);
    const d = [];
    const notes = [
      60, 64, 67, 72, 71, 67, 64, 62, 60, 64, 69, 72, 74, 72, 69, 67,
    ];
    for (let i = 0; i < notes.length; i++) {
      for (let c = 0; c < 3; c++) {
        const midi =
            c === 0
              ? notes[i]
              : c === 1
                ? notes[Math.floor(i / 4) * 4] - 12
                : notes[Math.floor(i / 4) * 4] - 24,
          per = Math.round(3579545 / 32 / (440 * 2 ** ((midi - 69) / 12)));
        d.push(
          0x50,
          0x80 + (c << 5) + (per & 15),
          0x50,
          (per >> 4) & 63,
          0x50,
          0x90 + (c << 5) + (c ? 5 : 1),
        );
      }
      d.push(
        0x50,
        0xe4,
        0x50,
        0xf6,
        0x61,
        0xb9,
        0x03,
        0x50,
        0xff,
        0x61,
        0x0f,
        0x20,
      );
      for (let c = 0; c < 3; c++) d.push(0x50, 0x9f + (c << 5));
      d.push(0x61, 0xb0, 0x04);
    }
    d.push(0x66);
    const b = new Uint8Array(64 + d.length);
    b.set(h);
    b.set(d, 64);
    new DataView(b.buffer).setUint32(4, b.length - 4, true);
    return b;
  }
  function demoPCMVGM() {
    const text =
      "VmdtIKgjAABxAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAC2CnUAAAAAAMwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGdmADoRAACAmK7C0dvg3tfKuaSNdV1INyoiICQuPVFnf5atwdDb4N/Yy7qljnZfSTcqIiAkLjxPZn2VrMDP2uDf2My7po93YEo4KyIgJC07TmR8lKu/z9rf39nNvKiReWFMOSsjICMsO01je5Kpvc7Z39/Zzr2pknpjTTosIyAjLDpMYnmRqLzN2d/f2s6+qpN7ZE47LSMgIys5S2B4kKe7zNjf4NrPv6uVfWVPPC0kICIqOEpfdo6musvY3+Db0MCtln5mUD0uJCAiKjdJXnWNpLnL197g29HBrpeAaFE+LyUgIik2R1x0jKO4ytfe4NzRwq+ZgWlTPzAlICEpNUZbcoqit8nW3uDc0sOwmoJqVEAwJiAhKDRFWnGJoLbI1d7g3NPEsZuEbFVBMSYhISczRFlwiJ+1x9Xd4N3UxbOdhW1WQjImISEnM0NXboaetMbU3eDd1Ma0noZuWEMzJyEhJjJCVm2FnbLF093g3dXHtZ+IcFlENCghISYxQVVshJuxxNPc4N7VyLahiXFaRTQoISAlMEBUaoKasMPS3ODe1sm3ootzW0Y1KSEgJTA/U2mBma/C0dvg3tfKuKOMdF1INikiICUvPlFof5euwdHb4N7Xy7mkjXVeSTcqIiAkLj1QZn6WrMDQ2+Df2Mu6po93X0o4KiIgJC08T2V9lau/z9rg39jMu6eQeGBLOSsjICMtO05ke5Oqvs7a39/Zzb2okXliTDosIyAjLDpNYnqSqb3O2d/f2c6+qZN7Y007LCMgIys5TGF5kai8zdnf39rPv6uUfGROPC0kICIrOEpgd4+mu8zY3+Da0MCslX1mUD0uJCAiKjdJX3aOpbrL2N/g29DBrZd/Z1E+LiQgIik3SF11jaS5ytfe4NvRwq6YgGhSPy8lICIpNkdcc4uiuMnW3uDc0sOvmYJqU0AwJSAhKDVGW3KKobfI1t7g3NLEsZuDa1RBMSYgISg0RVlwiKC1yNXe4NzTxbKchGxWQjEmISEnM0RYb4eftMfV3eDd1MaznYZuV0MyJyEhJzJDV26GnbPG1N3g3dTHtJ+Hb1hEMychISYxQlZshJyyxdPc4N3Vx7WgiHBZRTQoISAmMUFVa4ObscTT3ODe1si2oYpyW0Y1KCEgJTBAU2qCmbDD0tzg3tbJuKKLc1xHNikiICUvP1JogJiuwtHb4N7XyrmkjHRdSDYpIiAkLj5RZ3+XrcHQ2+Df2Mu6pY52Xkk3KiIgJC49UGZ+lazA0Nrg39jMu6aPd2BKOCsiICQtPE9kfJSrv8/a39/ZzbynkHhhSzkrIyAjLDtNY3uTqr7O2d/f2c29qZJ6Yk06LCMgIyw6TGJ5kai9zdnf39rOvqqTe2ROOy0jICMrOUtheJCnvMzY3+Daz7+rlH1lTzwtJCAiKjhKX3ePprvM2N/g29DArJZ+ZlA9LiQgIio3SV51jaW5y9fe4NvRwa6Xf2hRPi8lICIpNkhddIyjuMrX3uDb0cKvmIFpUj8vJSAiKTVHW3OLorfJ1t7g3NLDsJqCalRAMCUgISg0RVpxiaG2yNbe4NzTxLGbg2xVQTEmICEoNERZcIiftcfV3eDd08WynIVtVkIyJiEhJzNDWG+HnrTG1N3g3dTGs56GbldDMychIScyQlZthZ2zxdTd4N3Vx7WfiHBZRDMnISEmMUFVbIScscTT3ODe1ci2oIlxWkU0KCEgJjBAVGuCmrDD0tzg3tbJt6KKcltGNSghICUwP1NpgZmvwtLc4N7XyrijjHRcRzYpIiAlLz5SaICYrsHR2+De18q5pI11Xkg3KiIgJC49UGd+lq3A0Nvg39jLuqWOdl9KOCoiICQtPE9lfZWrv8/a4N/YzLunkHhgSzkrIyAkLTtOZHyUqr7P2t/f2c28qJF5YUw5LCMgIyw6TWN6kqm9ztnf39nOvamSemNNOiwjICMrOUxheZGovM3Z39/az76qlHxkTjstJCAiKzhLYHiQp7vM2N/g2s+/rJV9ZU88LiQgIio4SV92jqW6y9jf4NvQwK2WfmdRPS4kICIqN0hedY2kucrX3uDb0cGumIBoUj4vJSAiKTZHXHOLo7jJ197g3NLCr5mBaVM/MCUgISg1RltyiqG3ydbe4NzSw7Cag2tUQDAmICEoNEVacYmgtsjV3uDc08SynIRsVUExJiEhJzNEWG+Hn7TH1d3g3dTFs52FbVdCMichIScyQ1duhp6zxtTd4N3UxrSeh29YQzMnISEmMkJWbYWcssXT3eDd1ce1oIhwWUU0KCEgJjFBVWuDm7HE09zg3tbItqGJcVpGNSghICUwQFRqgpqww9Lc4N7Wybeii3NcRzUpIiAlLz9SaYGYr8LR2+De18q4o4x0XUg2KSIgJS8+UWd/l63B0Nvg39fLuqWNdV5JNyoiICQuPVBmfpaswNDb4N/YzLumj3dfSjgrIiAkLTxPZXyUq7/P2t/f2My8p5B4YUs5KyMgIy07TmN7k6q+ztrf39nNvaiSemJMOiwjICMsOkxiepKpvc3Z39/azr6qk3tjTTssIyAjKzlLYXiQp7zN2d/f2s+/q5R8ZU88LSQgIis4SmB3j6a7zNjf4NrQwKyWfmZQPS4kICIqN0ledo6lusvX3+Db0MGtl39nUT4vJCAiKTZIXXSMpLnK197g29HCr5iAaVI/LyUgIik1R1xzi6K3ydbe4NzSw7CagmpTQDAlICEoNUZacoqhtsjW3uDc08Sxm4NrVUExJiAhKDRFWXCIoLXH1d3g3dPFspyFbVZCMiYhISczRFhvh560xtTd4N3UxrOdhm5XQzInISEnMkNXboWds8XU3eDd1ce0n4dvWEQzJyEhJjFBVWyEnLLF09zg3tXItqCJcVpFNCghICYxQFRrg5qxxNLc4N7WybehinJbRjUoISAlMD9TaoGZr8PS3ODe1sm4o4tzXEc2KSIgJS8+UmiAmK7C0dvg3tfKuaSNdV1INyoiICQuPVFnf5atwdDb4N/Yy7qljnZfSTcqIiAkLjxPZn2VrMDP2uDf2My7po93YEo4KyIgJC07TmR8lKu/z9rf39nNvKiReWFMOSsjICMsO01je5Kpvc7Z39/Zzr2pknpjTTosIyAjLDpMYnmRqLzN2d/f2s6+qpN7ZE47LSMgIys5S2B4kKe7zNjf4NrPv6uVfWVPPC0kICIqOEpfdo6musvY3+Db0MCtln5mUD0uJCAiKjdJXnWNpLnL197g29HBrpeAaFE+LyUgIik2R1x0jKO4ytfe4NzRwq+ZgWlTPzAlICEpNUZbcoqit8nW3uDc0sOwmoJqVEAwJiAhKDRFWnGJoLbI1d7g3NPEsZuEbFVBMSYhISczRFlwiJ+1x9Xd4N3UxbOdhW1WQjImISEnM0NXboaetMbU3eDd1Ma0noZuWEMzJyEhJjJCVm2FnbLF093g3dXHtZ+IcFlENCghISYxQVVshJuxxNPc4N7VyLahiXFaRTQoISAlMEBUaoKasMPS3ODe1sm3ootzW0Y1KSEgJTA/U2mBma/C0dvg3tfKuKOMdF1INikiICUvPlFof5euwdHb4N7Xy7mkjXVeSTcqIiAkLj1QZn6WrMDQ2+Df2Mu6po93X0o4KiIgJC08T2V9lau/z9rg39jMu6eQeGBLOSsjICMtO05ke5Oqvs7a39/Zzb2okXliTDosIyAjLDpNYnqSqb3O2d/f2c6+qZN7Y007LCMgIys5TGF5kai8zdnf39rPv6uUfGROPC0kICIrOEpgd4+mu8zY3+Da0MCslX1mUD0uJCAiKjdJX3aOpbrL2N/g29DBrZd/Z1E+LiQgIik3SF11jaS5ytfe4NvRwq6YgGhSPy8lICIpNkdcc4uiuMnW3uDc0sOvmYJqU0AwJSAhKDVGW3KKobfI1t7g3NLEsZuDa1RBMSYgISg0RVlwiKC1yNXe4NzTxbKchGxWQjEmISEnM0RYb4eftMfV3eDd1MaznYZuV0MyJyEhJzJDV26GnbPG1N3g3dTHtJ+Hb1hEMychISYxQlZshJyyxdPc4N3Vx7WgiHBZRTQoISAmMUFVa4ObscTT3ODe1si2oYpyW0Y1KCEgJTBAU2qCmbDD0tzg3tbJuKKLc1xHNikiICUvP1JogJiuwtHb4N7XyrmkjHRdSDYpIiAkLj5RZ3+XrcHQ2+Df2Mu6pY52Xkk3KiIgJC49UGZ+lazA0Nrg39jMu6aPd2BKOCsiICQtPE9kfJSrv8/a39/ZzbynkHhhSzkrIyAjLDtNY3uTqr7O2d/f2c29qZJ6Yk06LCMgIyw6TGJ5kai9zdnf39rOvqqTe2ROOy0jICMrOUtheJCnvMzY3+Daz7+rlH1lTzwtJCAiKjhKX3ePprvM2N/g29DArJZ+ZlA9LiQgIio3SV51jaW5y9fe4NvRwa6Xf2hRPi8lICIpNkhddIyjuMrX3uDb0cKvmIFpUj8vJSAiKTVHW3OLorfJ1t7g3NLDsJqCalRAMCUgISg0RVpxiaG2yNbe4NzTxLGbg2xVQTEmICEoNERZcIiftcfV3eDd08WynIVtVkIyJiEhJzNDWG+HnrTG1N3g3dTGs56GbldDMychIScyQlZthZ2zxdTd4N3Vx7WfiHBZRDMnISEmMUFVbIScscTT3ODe1ci2oIlxWkU0KCEgJjBAVGuCmrDD0tzg3tbJt6KKcltGNSghICUwP1NpgZmvwtLc4N7XyrijjHRcRzYpIiAlLz5SaICYrsHR2+De18q5pI11Xkg3KiIgJC49UGd+lq3A0Nvg39jLuqWOdl9KOCoiICQtPE9lfZWrv8/a4N/YzLunkHhgSzkrIyAkLTtOZHyUqr7P2t/f2c28qJF5YUw5LCMgIyw6TWN6kqm9ztnf39nOvamSemNNOiwjICMrOUxheZGovM3Z39/az76qlHxkTjstJCAiKzhLYHiQp7vM2N/g2s+/rJV9ZU88LiQgIio4SV92jqW6y9jf4NvQwK2WfmdRPS4kICIqN0hedY2kucrX3uDb0cGumIBoUj4vJSAiKTZHXHOLo7jJ197g3NLCr5mBaVM/MCUgISg1RltyiqG3ydbe4NzSw7Cag2tUQDAmICEoNEVacYmgtsjV3uDc08SynIRsVUExJiEhJzNEWG+Hn7TH1d3g3dTFs52FbVdCMichIScyQ1duhp6zxtTd4N3UxrSeh29YQzMnISEmMkJWbYWcssXT3eDd1ce1oIhwWUU0KCEgJjFBVWuDm7HE09zg3tbItqGJcVpGNSghICUwQFRqgpqww9Lc4N7Wybeii3NcRzUpIiAlLz9SaYGYr8LR2+De18q4o4x0XUg2KSIgJS8+UWd/l63B0Nvg39fLuqWNdV5JNyoiICQuPVBmfpaswNDb4N/YzLumj3dfSjgrIiAkLTxPZXyUq7/P2t/f2My8p5B4YUs5KyMgIy07TmN7k6q+ztrf39nNvaiSemJMOiwjICMsOkxiepKpvc3Z39/azr6qk3tjTTssIyAjKzlLYXiQp7zN2d/f2s+/q5R8ZU88LSQgIis4SmB3j6a7zNjf4NrQwKyWfmZQPS4kICIqN0ledo6lusvX3+Db0MGtl39nUT4vJCAiKTZIXXSMpLnK197g29HCr5iAaVI/LyUgIik1R1xzi6K3ydbe4NzSw7CagmpTQDAlICEoNUZacoqhtsjW3uDc08Sxm4NrVUExJiAhKDRFWXCIoLXH1d3g3dPFspyFbVZCMiYhISczRFhvh560xtTd4N3UxrOdhm5XQzInISEnMkNXboWds8XU3eDd1ce0n4dvWEQzJyEhJjFBVWyEnLLF09zg3tXItqCJcVpFNCghICYxQFRrg5qxxNLc4N7WybehinJbRjUoISAlMD9TaoGZr8PS3ODe1sm4o4tzXEc2KSIgJS8+UmhnZgA6EQAAgJy2y9ng3tPCqo9zV0AuIyAmNEhifpq0ytjg3tTDrJF1WUEvIyAlM0dgfJizyNjf39XFrpN3W0MwJCAlMkVeepaxx9ff39bGsJV5XUQxJCAkMERceJSvxtbf39fHsZd7X0YyJSAkL0JadpKtxNXe39jJs5l9YUczJiAjLkFZdJCsw9Te4NnKtZt/Y0k0JiAjLT9Xco+qwdPe4NrLt52BZUs2JyAiLD5VcI2owNLd4NrNuJ+DZkw3KCEiKzxTboumvtHd4NvOuqGFaE44KSEhKjtRbImkvdDc4NzPu6OHalA6KiEhKTlQaoeiu8/b4NzQvaSJbFI7KiEhKThOaIWgus7b4N3RvqaLblM8KyIhKDdMZoOfuMza4N3SwKiNcFU+LCIgJzVKZICdtsvZ4N7TwaqPclc/LSMgJjRJYn6btcrZ4N7Uw6yRdFlBLiMgJjNHYHyZs8nY397VxK6TdltCLyQgJTJGX3qXscfX39/Wxq+VeFxEMSQgJDFEXXiVsMbW39/Xx7GXel5FMiUgJDBCW3aTrsXV3t/YyLOZfGBHMyUgIy5BWXSRrMPU3uDZyrSbfmJJNCYgIy0/V3KPqsLT3uDZy7acgGRKNScgIiw+VXCNqMDS3eDazLiegmZMNyghIis9VG+Lp7/R3eDbzbmghGhOOCghISo7Um2Jpb3Q3ODbz7uihmpPOSkhISo6UGuHo7zP3ODc0L2kiGxROyohISk4TmmFobrO2+Dd0b6mim5TPCsiISg3TWeDn7jN2uDd0sCojHBVPSwiICc2S2WBnbfL2uDd08GqjnJWPy0jICY0SWN/m7XK2eDe1MOrkHRYQC4jICYzSGF9mbPJ2N/e1cStknZaQi8kICUyRl97l7LI19/f1sWvlHhcQzAkICQxRF15lbDG1t/f18exlnpeRTElICQwQ1t3k67F1d/f2MiymHxgRzMlICMvQVl1kazD1d7f2Mm0mn5iSDQmICMuQFhzj6vC1N7g2cu2nIBkSjUnICItPlZxjanB093g2sy3noJlTDYnICIsPVRvjKe/0t3g2825oIRnTTgoISIrO1JtiqW+0Nzg2867ooZpTzkpISEqOlBriKO8z9zg3NC8pIhrUToqISEpOU9phqG6ztvg3NG+pYptUjwrIiEoN01ng6C5zdrg3dK/p4xvVD0sIiAnNktlgZ63zNrg3dPBqY5xVj8tIiAnNUpjf5y1y9ng3tTCq5BzWEAuIyAmNEhhfZq0ydjf3tXErZJ1WkIvIyAlMkZfe5iyyNff39bFrpR3XEMwJCAlMUVeeZawx9ff39fGsJZ5XUUxJSAkMENcd5Svxdbf39fIsph7X0YyJSAjL0JadZKtxNXe39jJtJp9YUgzJiAjLkBYc5CrwtTe4NnKtZx/Y0k1JyAiLT9WcY6pwdPd4NrMt52BZUs2JyAiLD1Ub4ynv9Ld4NrNuZ+DZ003KCEiKzxTboqmvtHc4NvOuqGFaU85KSEhKjpRbIikvNDc4NzPvKOHa1A6KiEhKTlPaoaiu87b4NzQvaWJbVI7KyEhKDhNaISguc3b4N3Rv6eLb1Q9LCIgKDZMZoKeuMza4N3SwKmNcVY+LSIgJzVKZICctsvZ4N7TwqqPc1dALiMgJjRIYn6atMrY4N7Uw6yRdVlBLyMgJTNHYHyYs8jY39/Vxa6Td1tDMCQgJTFFXnqWscfX39/WxrCVeV1EMSQgJDBEXHiUr8bW39/Xx7KXe19GMiUgJC9CWnaSrcTV3t/YybOZfWFHMyYgIy5BWHSQrMPU3uDZyrWbf2NJNCYgIy0/V3KOqsHT3uDay7edgWVLNicgIiw+VXCMqMDS3eDazbifg2ZMNyghIis8U26Kpr7R3eDbzrqhhWhOOCkhISo7UWyIpL3Q3ODcz7ujh2pQOiohISk5UGqGorvP2+Dc0L2liWxSOyohISk4TmiEoLrO2+Dd0b+mi25TPCsiISg3TGaCn7jM2uDd0sCojXBVPiwiICc1SmSAnbbL2eDe08Kqj3JXPy0jICY0SWJ+m7XK2eDe1MOskXRZQS4jICYzR2B8mbPJ2N/e1cSuk3ZbQi8kICUyRl96l7HH19/f1savlXhcRDEkICQxRF14la/G1t/f18exl3peRTIlICQwQlt2k67F1d7f2MizmXxgRzMlICMuQVl0kazD1N7g2cq0m35iSTQmICMtP1dyj6rC097g2cu2nIBkSjUnICIsPlVwjajA0t3g2sy4noJmTDcoISIrPFRui6e/0d3g2825oIRoTjgoISEqO1JtiaW90Nzg28+7ooZqTzkpISEqOlBrh6O8z9zg3NC9pIhsUTsqISEpOE5phaG6ztvg3dG+popuUzwrIiEoN01ng5+4zdrg3dLAqIxwVT0sIiAnNktlgZ23y9rg3tPBqo5yVz8tIyAmNEljf5u1ytng3tTDq5B0WEAuIyAmM0hhfZmzydjf3tXErZJ2WkIvJCAlMkZfe5eyyNff39bFr5R4XEMwJCAkMURdeZWwxtbf39fHsZZ6XkUxJSAkMENbd5OuxdXf39jIsph8YEczJSAjL0FZdZGsw9Xe39jJtJp+Ykg0JiAjLkBYc4+rwtTe4NnLtpyAZEo1JyAiLT5WcY2pwdPd4NrMt56CZkw2JyAiLD1Ub4unv9Ld4NvNuaCEZ004KCEiKztSbYmlvdDc4NvOu6KGaU85KSEhKjpQa4ejvM/c4NzQvKSIa1E6KiEhKTlPaYWhus7b4NzRvqWKbVI8KyIhKDdNZ4Ofuc3a4N3Sv6eMb1Q9LCIgJzZLZYGet8za4N3TwamOcVY/LSIgJzVKY3+ctcvZ4N7UwquQc1hALiMgJjRIYX2atMnY397VxK2SdVpCLyMgJTJGX3uYssjX39/Wxa6Ud1xDMCQgJTFFXnmWsMfX39/XxrCWeV1FMSUgJDBDXHeUr8XW39/XyLKYe19GMiUgIy9CWnWSrcTV3t/YybSafWFIMyYgIy5AWHOQq8LU3uDZyrWcf2NKNScgIi0/VnGOqcHT3eDazLedgWVLNicgIiw9VG+Mp7/S3eDazbmfg2dNNyghIis8U22Kpr7R3ODbzrqhhWlPOSkhISo6UWyIpLzQ3ODcz7yjh2tQOiohISk5T2qGorvO2+Dc0L2liW1SOysiISg4TWiEoLnN2+Dd0b+ni29UPSwiICg2TGaCnrjM2uDd0sCpjXFWPi0iICc1SmSAnLbL2eDe1MKqj3NXQC4jICY0SGJ+mrTK2ODe1MOskXVZQS8jICUzR2B8mLLI2N/f1cWuk3dbQzAkICUxRV56lrHH19/f1sawlXldRDEkICQwRFx4lK/G1t/f18iyl3tfRjIlICQvQlp2kq3E1d7f2MmzmX1hRzMmICMuQVh0kKvD1N7g2cq1m39jSTQmICMtP1dyjqrB097g2su3nYFlSzYnICIsPlVwjKjA0t3g2s24n4NnTDcoISIrPFNuiqa+0d3g2866oYVoTjgpISEqO1FsiKS90Nzg3M+7o4dqUDoqISEpOVBqhqK7z9vg3NC9pYlsUjsqISEpOE5ohKC6ztvg3dG/potuUzwrIiEoN0xmgp+4zNrg3dLAqI1wVT4sIiAnNUpkgJ22y9ng3tPCqo9yVz8tIyAmNElifpu1ytng3tTDrJF0WUEuIyAmM0dgfJmzydjf3tXErpN2W0IvJCAlMkZeepexx9ff39bGr5V4XUQxJCAkMURdeJWvxtbf39fHsZd6XkUyJSAkL0JbdpOuxNXe39jJs5l8YEczJSAjLkFZdJGsw9Te4NnKtZt+Ykk0JiAjLT9Xco+qwtPe4NnLtp2AZEo1JyAiLD5VcI2owNLd4NrMuJ6CZkw3KCEiKzxTboumv9Hd4NvOuaCEaE44KCEhKjtSbImlvdDc4NvPu6KGak85KSEhKjpQa4ejvM/c4NzQvaSIbFE7KiEhKThOaYWhus7b4N3RvqaKblM8KyIhKDdNZ4OfuM3a4N3SwKiMcFU9LCIgJzZLZYGdt8va4N7TwaqOclc/LSMgJjRJY3+btcrZ4N7Uw6uQdFhALiMgJjNIYX2Zs8nY397VxK2SdlpCLyQgJTJGX3uXssjX39/Wxa+UeFxDMCQgJDFEXXmVsMbW39/Xx7GWel5FMSUgJDBDW3eTrsXV39/YyLKYfGBHMyUgIy9BWXWRrMPV3t/YybSafmJINCYgIy5AWHOPq8LU3uDZy7acgGRKNScgIi0+VnGNqcHT3eDazLeegmZMNicgIiw9VG+Lp7/S3eDbzbmghGdNOCghIis7Um2Jpb3Q3ODbzruihmlPOSkhISo6UGuHo7zP3ODc0LykiGtROiohISk5T2mFobrO2+Dc0b6lim1TPCsiISg3TWeDn7nN2uDd0r+njG9UPSwiICc2S2WBnrfM2uDd08GpjnFWPy0iICc1SmN/nLXL2eDe1MKrkHNYQC4jICY0SGF9mrTJ2N/e1cStknVaQi8jICUyRl97mLLI19/f1sWvlHdcQzAkICUxRV55lrDH19/f18ewlnldRTElICQwQ1x3lK/F1t/f18iymHtfRjIlICMvQlp1kq3E1d7f2Mm0mn1hSDMmICMuQFhzkKvC1N7g2cq1nH9jSjUnICItP1ZxjqnB093g2sy3nYFlSzYnICIsPVRvjKe/0t3g2s25n4NnTTcoISIrPFNtiqa+0dzg2866oYVpTzkpISEqOlFriKS80Nzg3M+8o4drUDoqISEpOU9qhqK7ztvg3NC9pYltUjsrIiEoOE1ohKC5zdvg3dG/p4tvVD0sIiAoNkxmgp63zNrg3dPAqY1xVj4tIiAnNUpkgJy2y9ng3tTCq49zV0AuIyAmNEhifpq0ytjg3tTDrJF1WUEvIyAlM0dgfJiyyNjf39XFrpN3W0MwJCAlMUVeepaxx9ff39bGsJV5XUQxJCAkMERceJSvxtbf39fIspd7X0YyJSAkL0JadpKtxNXe39jJs5l9YUczJiAjLkBYdJCrw9Te4NnKtZt/Y0k0JiAjLT9Xco6qwdPe4NrLt52BZUs2JyAiLD5VcIyowNLd4NrNuJ+DZ0w3KCEiKzxTboqmvtHd4NvOuqGFaE44KSEhKjtRbIikvdDc4NzPu6OHalA6KiEhKTlQaoaiu8/b4NzQvaWJbFI7KiEhKThOaISgus7b4N3Rv6aLblM8KyIhKDdMZoKfuMza4N3SwKiNcFU+LCIgJzVKZICdtsvZ4N7TwqqPclc/LSMgJjRJYn6btcrZ4N7Uw6yRdFlBLiMgJjNHYHyZs8nY397VxK6TdltCLyQgJTJGXnqXscfX39/Wxq+VeF1EMSQgJDFEXXiVr8bW39/Xx7GXel5FMiUgJC9CW3aTrsTV3t/YybOZfGBHMyUgIy5BWXSRrMPU3uDZyrWbfmJJNCYgIy0/V3KPqsLT3uDZy7adgGRKNScgIiw+VXCNqMDS3eDazLiegmZMNyghIis8U26Lpr/R3eDbzrmghGhOOCghISo7UmyJpb3Q3ODbz7uihmpPOSkhISo6UGqHo7zP3ODc0L2kiGxROyohISk4TmmFobrO2+Dd0b6mim5TPCsiISg3TWeDn7jN2uDd0sCojHBVPSwiICc2S2WBnbfL2uDe08GqjnJXPy0jICY0SWN/m7XK2eDe1MOrkHRYQC4jICYzSGF9mbPJ2N/e1cStknZaQi8kICUyRl97l7LI19/f1sWvlHhcRDAkICQxRF15lbDG1t/f18exlnpeRTElICQwQ1t3k67F1d/f2MiymHxgRzMlICMvQVl1kazD1d7f2Mq0mn5iSDQmICMuQFhzj6vC1N7g2cu2nIBkSjUnICItPlZxjanA093g2sy3noJmTDYnICIsPVRvi6e/0d3g2825oIRoTTgoISIrO1JtiaW90NzgUiuAU7bAkAACACqRAAABAJIAESsAAJUAAAAAYehEYToRlQABAABh6ERm";
    const bin =
      typeof atob === "function"
        ? atob(text)
        : Buffer.from(text, "base64").toString("binary");
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  function demoSegaVGM() {
    const bin = atob(
      "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",
    );
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }
  root.VGMCore = {
    parseVGM,
    decode,
    decompress,
    gymToVGM,
    exportMIDI,
    demoVGM,
    demoPCMVGM,
    demoSegaVGM,
    mapPCM,
    pcmWAV,
    analyzePCM,
    GM,
    SUPPORTED: [...SUPPORTED],
    SR,
  };
  if (typeof module !== "undefined" && module.exports)
    module.exports = root.VGMCore;
})(typeof globalThis !== "undefined" ? globalThis : self);
