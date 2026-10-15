function ensureAudio() {
  if (!audio) {
    audio = new (window.AudioContext || window.webkitAudioContext)();
    master = audio.createGain();
    master.gain.value = 0.65;
    const compressor = audio.createDynamicsCompressor();
    compressor.threshold.value = -12;
    compressor.ratio.value = 6;
    master.connect(compressor);
    compressor.connect(audio.destination);
  }
  return audio;
}

function busFor(tr, st) {
  let b = buses.get(tr.id);
  if (b) return b;
  const ctx = ensureAudio(),
    gain = ctx.createGain(),
    analyser = ctx.createAnalyser();
  analyser.fftSize = 4096;
  gain.gain.setValueAtTime((st.volume / 127) * 0.5, ctx.currentTime);
  gain.connect(analyser);
  analyser.connect(master);
  b = {
    gain,
    analyser,
    rate: ctx.sampleRate,
    data: new Float32Array(analyser.fftSize),
  };
  buses.set(tr.id, b);
  return b;
}

function clearBuses() {
  for (const b of buses.values()) {
    b.gain.disconnect();
    b.analyser.disconnect();
  }
  buses.clear();
}

function stopAudio() {
  audioTicket++;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = null;
  }
  if (playState) {
    clearInterval(playState.timer);
    for (const n of [...playState.nodes])
      try {
        n.stop();
      } catch {}
    playState = null;
  }
  clearBuses();
  if (pcmPreviewCard) {
    pcmPreviewCard.el.hidden = true;
    paintScope(pcmPreviewCard, null);
  }
  $("stop").disabled = $("pause").disabled = true;
  $("play").textContent = "▶ Ouvir prévia";
  for (const card of scopeCards.values()) {
    card.el.classList.remove("playing");
    card.note.textContent = "—";
    card.level.style.width = "0%";
    for (const k of card.keys) k.classList.remove("on");
    paintScope(card, null);
  }
  if (selectedEntry()?.song) draw(false);
}

function voicePreview(note, tr, st, when, offset) {
  const ctx = audio,
    s = note.start / C.SR,
    e = note.end / C.SR,
    start = Math.max(s, offset, offset + ctx.currentTime - when),
    dur = e - start;
  if (dur <= 0) return;
  const t0 = when + (start - offset),
    t1 = t0 + dur,
    shift = tr.drum ? 0 : Number($("transpose").value) + st.transpose,
    key = note.key + shift,
    bus = busFor(tr, st),
    expression = ctx.createGain(),
    pts = note.points;
  let first = pts[0];
  for (const p of pts) {
    if (p.time / C.SR <= start) first = p;
    else break;
  }
  expression.gain.setValueAtTime(first.volume / 127, t0);
  for (const p of pts)
    if (p.time / C.SR > start && p.time / C.SR < e)
      expression.gain.setValueAtTime(
        p.volume / 127,
        when + p.time / C.SR - offset,
      );
  expression.connect(bus.gain);
  const state = playState;
  if (fontState && $("audio-engine").value === "sf2") {
    sampler = sampler || new SF2.Sampler(ctx, fontState);
    const preset = sampler.choose(
        st.program >= 0 ? st.program : note.program,
        tr.drum,
        st.sfPreset ?? -1,
      ),
      points = [
        { at: t0, pitch: first.pitch + shift, pan: first.pan },
        ...pts
          .filter((p) => p.time / C.SR > start)
          .map((p) => ({
            at: when + p.time / C.SR - offset,
            pitch: p.pitch + shift,
            pan: p.pan,
          })),
      ];
    let voices;
    try {
      voices = sampler.play(
        preset,
        key,
        note.velocity,
        t0,
        t1,
        points,
        expression,
        start - s,
        256 - state.nodes.size,
      );
    } catch (error) {
      expression.disconnect();
      throw error;
    }
    let left = voices.length;
    for (const voice of voices) {
      state.nodes.add(voice);
      voice.onended = () => {
        state.nodes.delete(voice);
        if (--left === 0) expression.disconnect();
      };
    }
    if (!voices.length) {
      expression.disconnect();
      state.missingSamples = (state.missingSamples || 0) + 1;
      if (state.missingSamples === 1)
        status(
          "O preset escolhido não tem sample para algumas notas. Experimente outro preset.",
        );
    }
    return;
  }
  const node = tr.drum ? ctx.createBufferSource() : ctx.createOscillator(),
    gain = ctx.createGain(),
    pan = ctx.createStereoPanner(),
    prog = st.program >= 0 ? st.program : note.program;
  if (tr.drum) {
    if (!noiseBuffer) {
      noiseBuffer = ctx.createBuffer(
        1,
        Math.ceil(ctx.sampleRate * 0.12),
        ctx.sampleRate,
      );
      const a = noiseBuffer.getChannelData(0);
      for (let i = 0; i < a.length; i++)
        a[i] = (Math.random() * 2 - 1) * (1 - i / a.length) ** 3;
    }
    node.buffer = noiseBuffer;
    node.loop = true;
  } else
    node.type =
      prog >= 80 && prog < 88
        ? "square"
        : prog >= 32 && prog < 40
          ? "triangle"
          : prog >= 16 && prog < 24
            ? "sine"
            : prog >= 24 && prog < 32
              ? "triangle"
              : "sine";
  node.connect(gain);
  gain.connect(pan);
  pan.connect(expression);
  if (!tr.drum)
    node.frequency.setValueAtTime(
      440 * 2 ** ((first.pitch + shift - 69) / 12),
      t0,
    );
  pan.pan.setValueAtTime((first.pan - 64) / 64, t0);
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(0.16, t0 + Math.min(0.004, dur / 3));
  for (const p of pts) {
    const time = p.time / C.SR;
    if (time <= start || time >= e) continue;
    const at = when + time - offset;
    if (!tr.drum)
      node.frequency.setValueAtTime(
        440 * 2 ** ((p.pitch + shift - 69) / 12),
        at,
      );
    pan.pan.setValueAtTime((p.pan - 64) / 64, at);
  }
  gain.gain.setValueAtTime(0.16, Math.max(t0, t1 - 0.006));
  gain.gain.linearRampToValueAtTime(0, t1);
  node.start(t0);
  node.stop(t1 + 0.01);
  const voice = {
    stop() {
      try {
        node.stop();
      } catch {}
    },
  };
  state.nodes.add(voice);
  node.onended = () => {
    state.nodes.delete(voice);
    node.disconnect();
    gain.disconnect();
    pan.disconnect();
    expression.disconnect();
  };
}

async function play() {
  stopAudio();
  const x = selectedEntry();
  if (!x?.song || working || loading || fontLoading) return;
  const ticket = audioTicket;
  try {
    ensureAudio();
    await audio.resume();
    if (ticket !== audioTicket) return;
    const song = x.song;
    let offset = (Number($("seek").value) / 1000) * song.duration;
    if (offset >= song.duration) offset = 0;
    const notes = [];
    for (const t of song.tracks) {
      const st = setting(x, t);
      if (!st.enabled || !st.volume) continue;
      busFor(t, st);
      for (const n of t.notes)
        if (n.end / C.SR > offset) notes.push({ n, t, st });
    }
    if (!notes.length) {
      clearBuses();
      status("Não há pistas ativas com notas para reproduzir.", "error");
      return;
    }
    notes.sort((a, b) => a.n.start - b.n.start);
    const state = {
      nodes: new Set(),
      timer: null,
      at: 0,
      visualAt: 0,
      notes,
      active: new Map(),
      when: audio.currentTime + 0.05,
      offset,
      song,
    };
    playState = state;
    const schedule = () => {
      if (playState !== state) return;
      try {
        const now = audio.currentTime - state.when + offset;
        while (
          state.at < notes.length &&
          notes[state.at].n.start / C.SR < now + 0.2
        ) {
          const o = notes[state.at++];
          if (o.n.end / C.SR > now) {
            if (state.nodes.size < 256)
              voicePreview(o.n, o.t, o.st, state.when, offset);
            else {
              state.dropped = (state.dropped || 0) + 1;
              if (state.dropped === 1)
                status(
                  "A prévia atingiu o limite de vozes. Desative algumas pistas ou escolha presets com menos camadas.",
                );
            }
          }
        }
        if (now > song.duration + 3.2) {
          stopAudio();
        }
      } catch (e) {
        stopAudio();
        status("Falha na reprodução: " + e.message, "error");
      }
    };
    state.timer = setInterval(schedule, 45);
    schedule();
    if (playState !== state) return;
    $("play").textContent = "↺ Reiniciar prévia";
    $("stop").disabled = $("pause").disabled = false;
    lastFrame = 0;
    raf = requestAnimationFrame(animateAudio);
    status(
      "Tocando com " +
        (fontState && $("audio-engine").value === "sf2"
          ? fontState.name
          : "síntese simples") +
        "." +
        (state.missingSamples
          ? " Algumas notas não têm sample no preset escolhido."
          : ""),
    );
  } catch (err) {
    stopAudio();
    status("A prévia sonora não pôde iniciar: " + err.message, "error");
  }
}

function animateAudio(stamp) {
  const st = playState;
  if (!st) return;
  if (stamp - lastFrame < 1000 / 30) {
    raf = requestAnimationFrame(animateAudio);
    return;
  }
  lastFrame = stamp;
  if (st.audition) {
    const b = buses.get("pcm-preview");
    if (b) {
      b.analyser.getFloatTimeDomainData(b.data);
      if (pcmPreviewCard)
        paintScope(pcmPreviewCard, b.data, b.rate, st.frequency);
      const card = scopeCards.get(st.trackId);
      if (card) paintScope(card, b.data, b.rate, st.frequency);
    }
    raf = requestAnimationFrame(animateAudio);
    return;
  }
  if (!st.song) return;
  const now = Math.max(0, audio.currentTime - st.when + st.offset),
    pos = Math.min(st.song.duration, now);
  $("seek").value = String(
    st.song.duration ? (pos / st.song.duration) * 1000 : 0,
  );
  updateClock(pos);
  while (
    st.visualAt < st.notes.length &&
    st.notes[st.visualAt].n.start / C.SR <= now
  ) {
    const o = st.notes[st.visualAt++];
    if (o.n.end / C.SR > now) st.active.set(o.n, o);
  }
  for (const [id, o] of st.active)
    if (o.n.end / C.SR <= now) st.active.delete(id);
  const animations = $("animations").checked,
    visible = new Map();
  for (const o of st.active.values()) {
    if (!visible.has(o.t.id)) visible.set(o.t.id, []);
    visible.get(o.t.id).push(o);
  }
  for (const [id, card] of scopeCards) {
    const b = buses.get(id),
      chord = visible.get(id) || [],
      o = chord.at(-1);
    if (b) b.analyser.getFloatTimeDomainData(b.data);
    paintScope(
      card,
      b?.data,
      b?.rate,
      o
        ? 440 *
            2 **
              ((o.n.key +
                (o.t.drum ? 0 : Number($("transpose").value) + o.st.transpose) -
                69) /
                12)
        : 440,
    );
    card.el.classList.toggle("playing", animations && !!o);
    const k = o
      ? o.n.key + (o.t.drum ? 0 : Number($("transpose").value) + o.st.transpose)
      : null;
    const keys = chord.map(
      (v) =>
        v.n.key +
        (v.t.drum ? 0 : Number($("transpose").value) + v.st.transpose),
    );
    card.note.textContent = keys.length
      ? keys.slice(-4).map(noteName).join(" ")
      : "—";
    for (let i = 0; i < 12; i++)
      card.keys[i].classList.toggle(
        "on",
        animations && keys.some((k) => ((k % 12) + 12) % 12 === i),
      );
  }
  draw(false);
  if (now >= st.song.duration + 1.2 && st.nodes.size === 0) {
    stopAudio();
    $("seek").value = "0";
    updateClock(0);
    draw(false);
    status("Reprodução concluída.", "ok");
    return;
  }
  raf = requestAnimationFrame(animateAudio);
}

async function playPCM(seg) {
  if (working || loading || fontLoading) return;
  stopAudio();
  const ticket = audioTicket;
  try {
    ensureAudio();
    await audio.resume();
    if (ticket !== audioTicket) return;
    const buffer = audio.createBuffer(1, seg.data.length, seg.sampleRate);
    buffer.getChannelData(0).set(seg.data);
    const node = audio.createBufferSource(),
      bus = busFor({ id: "pcm-preview" }, { volume: 76.2 });
    node.buffer = buffer;
    node.connect(bus.gain);
    const track = selectedEntry()?.song?.tracks.find((t) =>
        t.notes.some((n) => n.pcmId === seg.id),
      ),
      state = {
        nodes: new Set([node]),
        timer: null,
        audition: true,
        trackId: track?.id,
        frequency: 440 * 2 ** ((seg.analysis.note - 69) / 12),
      };
    playState = state;
    node.onended = () => {
      state.nodes.delete(node);
      node.disconnect();
      if (ticket === audioTicket) stopAudio();
    };
    if (pcmPreviewCard) {
      pcmPreviewCard.el.hidden = false;
      pcmPreviewCard.note.textContent = "Trecho " + (seg.id + 1);
    }
    node.start();
    $("stop").disabled = false;
    lastFrame = 0;
    raf = requestAnimationFrame(animateAudio);
    status("Ouvindo PCM recuperado do trecho " + (seg.id + 1) + ".");
  } catch (err) {
    stopAudio();
    status("Não foi possível ouvir PCM: " + err.message, "error");
  }
}
