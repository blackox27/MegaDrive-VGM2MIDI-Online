function renderPCM(x) {
  pcmPreviewCard = null;
  const panel = $("pcm-panel");
  panel.replaceChildren();
  const segments = x?.song?.pcmSegments || [];
  panel.hidden = !segments.length;
  if (!segments.length) return;
  const title = document.createElement("h2");
  title.textContent = "PCM / DAC · " + segments.length + " trechos recuperados";
  const hint = document.createElement("p");
  hint.textContent =
    "Revise as sugestões antes de exportar. Automático tenta notas monofônicas ou percussão; modo manual atribui uma nota ao trecho inteiro. WAV: áudio reconstruído em mono, 22.050 Hz. O MIDI não incorpora o sample.";
  panel.append(title, hint);
  const monitor = document.createElement("div");
  monitor.className = "scope-card pcm-monitor";
  monitor.hidden = true;
  monitor.style.setProperty("--voice", palette[4]);
  monitor.innerHTML =
    '<div class="scope-meta"><span class="scope-name">Áudio PCM recuperado</span><span class="scope-note">—</span></div><canvas aria-label="Osciloscópio do trecho PCM recuperado"></canvas><div class="scope-foot"><span>Escala visual automática</span><span class="level"><i></i></span></div>';
  const canvas = monitor.querySelector("canvas");
  canvas.width = 512;
  canvas.height = 144;
  pcmPreviewCard = {
    el: monitor,
    canvas,
    ctx: canvas.getContext("2d"),
    color: palette[4],
    note: monitor.querySelector(".scope-note"),
    keys: [],
    level: monitor.querySelector(".level i"),
  };
  panel.append(monitor);
  paintScope(pcmPreviewCard, null);
  const page = Math.min(x.pcmPage || 0, Math.floor((segments.length - 1) / 20));
  x.pcmPage = page;
  const table = document.createElement("table");
  table.innerHTML =
    "<thead><tr><th>TRECHO / SUGESTÃO</th><th>TRANSCRIÇÃO</th><th>NOTA MIDI 0–127</th><th>ÁUDIO RECUPERADO</th></tr></thead>";
  const body = document.createElement("tbody");
  table.append(body);
  const scroll = document.createElement("div");
  scroll.className = "table-scroll";
  scroll.append(table);
  panel.append(scroll);
  for (const seg of segments.slice(page * 20, page * 20 + 20)) {
    const o = (x.pcmSettings || (x.pcmSettings = {}))[seg.id] || {},
      row = document.createElement("tr");
    row.innerHTML =
      '<td></td><td><select aria-label="Modo PCM ' +
      seg.id +
      '"><option value="auto">Automático</option><option value="tonal">Nota manual</option><option value="percussion">Percussão manual</option><option value="ignore">Ignorar</option></select></td><td><input type="number" min="0" max="127" step="1" aria-label="Nota PCM ' +
      seg.id +
      '"></td><td><button class="small">▶ Ouvir</button> <button class="small">↓ WAV</button></td>';
    row.cells[0].textContent =
      "#" +
      (seg.id + 1) +
      " · " +
      (seg.start / C.SR).toFixed(2) +
      "s · " +
      ((seg.end - seg.start) / C.SR).toFixed(2) +
      "s · " +
      seg.source +
      " · " +
      (seg.analysis.kind === "tonal"
        ? "nota " + seg.analysis.note
        : "percussão " + seg.analysis.drum) +
      " · periodicidade " +
      Math.round(seg.analysis.confidence * 100) +
      "%";
    const mode = row.querySelector("select"),
      key = row.querySelector("input"),
      buttons = row.querySelectorAll("button");
    mode.value = o.mode || "auto";
    key.value =
      o.key ??
      (seg.analysis.kind === "tonal" ? seg.analysis.note : seg.analysis.drum);
    key.disabled = ["auto", "ignore"].includes(mode.value);
    const update = () => {
      const value = Number(key.value);
      if (!Number.isInteger(value) || value < 0 || value > 127) {
        status("Nota PCM deve ser um inteiro de 0 a 127.", "error");
        return;
      }
      stopAudio();
      x.pcmSettings[seg.id] = { mode: mode.value, key: value };
      x.song = C.mapPCM(x.song, x.pcmSettings);
      render();
      refreshQueue();
    };
    mode.onchange = () => {
      if (mode.value === "percussion") key.value = o.key ?? seg.analysis.drum;
      else if (mode.value === "tonal") key.value = o.key ?? seg.analysis.note;
      update();
    };
    key.onchange = update;
    buttons[0].onclick = () => playPCM(seg);
    buttons[1].onclick = () =>
      save(
        C.pcmWAV(seg),
        fileBase(x.name) +
          "-PCM-" +
          String(seg.id + 1).padStart(3, "0") +
          ".wav",
        "audio/wav",
      );
    body.append(row);
  }
  const nav = document.createElement("div");
  nav.className = "row";
  const prev = document.createElement("button"),
    next = document.createElement("button"),
    label = document.createElement("span");
  prev.textContent = "← Anteriores";
  next.textContent = "Próximos →";
  label.textContent =
    "Página " + (page + 1) + " de " + Math.ceil(segments.length / 20);
  prev.disabled = page === 0;
  next.disabled = (page + 1) * 20 >= segments.length;
  prev.onclick = () => {
    stopAudio();
    x.pcmPage--;
    renderPCM(x);
  };
  next.onclick = () => {
    stopAudio();
    x.pcmPage++;
    renderPCM(x);
  };
  nav.append(prev, label, next);
  panel.append(nav);
}
