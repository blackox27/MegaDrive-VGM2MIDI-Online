function paintScope(card, data, sampleRate = 44100, frequency = 440) {
  const g = card.ctx,
    w = card.canvas.width,
    h = card.canvas.height;
  g.fillStyle = "#0c0d13";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "#252537";
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 4; i++) {
    g.moveTo((w * i) / 4, 0);
    g.lineTo((w * i) / 4, h);
  }
  g.moveTo(0, h / 2);
  g.lineTo(w, h / 2);
  g.stroke();
  const signal = ScopeDSP.trace(
    data,
    sampleRate,
    frequency,
    card.scopePeak,
    512,
    card.scopeValues || (card.scopeValues = new Float32Array(512)),
  );
  card.scopePeak = signal.envelope;
  const db = signal.rms ? 20 * Math.log10(signal.rms) : -Infinity;
  card.level.style.width =
    Math.max(0, Math.min(100, ((db + 80) / 80) * 100)) + "%";
  card.level.parentElement.title = Number.isFinite(db)
    ? db.toFixed(1) + " dBFS · nível real"
    : "Silêncio";
  g.strokeStyle = card.color;
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i < signal.values.length; i++) {
    const x = (i / (signal.values.length - 1)) * w,
      y = h / 2 - signal.values[i] * h * 0.42;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
}

function renderScopes(song) {
  scopeCards.clear();
  $("scope-grid").replaceChildren();
  $("scope-nav").replaceChildren();
  if (!song) return;
  const max = 12,
    count = Math.ceil(song.tracks.length / max);
  scopePage = Math.min(scopePage, Math.max(0, count - 1));
  for (const [i, tr] of song.tracks
    .slice(scopePage * max, (scopePage + 1) * max)
    .entries()) {
    const color = palette[(scopePage * max + i) % palette.length],
      el = document.createElement("div");
    el.className = "scope-card";
    el.style.setProperty("--voice", color);
    el.innerHTML =
      '<div class="scope-meta"><span class="scope-name"></span><span class="scope-note">—</span></div><canvas aria-label="Osciloscópio"></canvas><div class="scope-keys" aria-hidden="true">' +
      Array.from(
        { length: 12 },
        (_, j) =>
          '<i class="scope-key' +
          ([1, 3, 6, 8, 10].includes(j) ? " black" : "") +
          '"></i>',
      ).join("") +
      '</div><div class="scope-foot"><span></span><span class="level"><i></i></span></div>';
    el.querySelector(".scope-name").textContent = tr.name;
    el.querySelector(".scope-name").title = tr.name;
    const st = setting(selectedEntry(), tr);
    if (!st.enabled) el.style.opacity = ".45";
    const preset =
      fontState && $("audio-engine").value === "sf2"
        ? SF2.choose(
            fontState,
            st.program >= 0 ? st.program : tr.program,
            tr.drum,
            st.sfPreset ?? -1,
          )
        : null;
    el.querySelector(".scope-foot span").dataset.i18nSkip = String(!!preset);
    el.querySelector(".scope-foot span").textContent =
      preset?.name ||
      (tr.drum ? "PERCUSSÃO" : tr.pcm ? "PCM / DAC" : "MELODIA");
    el.querySelector(".scope-foot span").title = preset?.name || tr.name;
    const canvas = el.querySelector("canvas");
    canvas.width = 512;
    canvas.height = 144;
    const card = {
      el,
      canvas,
      ctx: canvas.getContext("2d"),
      color,
      note: el.querySelector(".scope-note"),
      keys: [...el.querySelectorAll(".scope-key")],
      level: el.querySelector(".level i"),
    };
    scopeCards.set(tr.id, card);
    $("scope-grid").append(el);
    paintScope(card, null);
  }
  if (count > 1) {
    const prev = document.createElement("button"),
      next = document.createElement("button"),
      label = document.createElement("span");
    prev.textContent = "← Pistas";
    next.textContent = "Pistas →";
    label.textContent = "Página " + (scopePage + 1) + " / " + count;
    prev.disabled = scopePage === 0;
    next.disabled = scopePage === count - 1;
    prev.onclick = () => {
      scopePage--;
      renderScopes(song);
    };
    next.onclick = () => {
      scopePage++;
      renderScopes(song);
    };
    $("scope-nav").append(prev, label, next);
  }
}
