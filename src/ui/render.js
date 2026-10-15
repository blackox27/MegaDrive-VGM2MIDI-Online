function selectView(name) {
  document
    .querySelectorAll(".view")
    .forEach((v) => (v.hidden = v.id !== "view-" + name));
  document
    .querySelectorAll("nav button")
    .forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name === "convert") draw();
}

function render() {
  const x = selectedEntry(),
    s = x?.song;
  $("result").hidden = !s;
  $("empty-main").hidden = !!s;
  $("seek").value = "0";
  $("stop").disabled = true;
  $("reconvert").disabled = working || !x;
  renderPCM(x);
  renderScopes(s);
  if (!s) {
    if (x?.error) status(x.name + ": " + x.error, "error");
    else if (!working)
      status(
        x
          ? "Arquivo aguardando conversão. Clique em Reconverter selecionado."
          : "Pronto. Selecione uma música ou experimente a demonstração.",
      );
    return;
  }
  const count = s.tracks.reduce((n, t) => n + t.notes.length, 0);
  $("stat-time").textContent = fmt(s.duration);
  $("stat-tracks").textContent = s.tracks.length;
  $("stat-notes").textContent = count.toLocaleString(I18n.locale);
  $("stat-format").textContent =
    s.format === "GYM" ? "GYM" : "VGM " + s.version;
  $("song-title").dataset.i18nSkip = "true";
  $("song-title").textContent = s.metadata.title || x.name;
  const chips = $("chips");
  chips.replaceChildren();
  for (const n of Object.keys(s.clocks)) {
    const el = document.createElement("span");
    el.className = "chip";
    el.textContent = n;
    chips.append(el);
  }
  const tbody = $("track-body");
  tbody.replaceChildren();
  for (let i = 0; i < s.tracks.length; i++) {
    const tr = s.tracks[i],
      v = setting(x, tr),
      row = document.createElement("tr");
    row.innerHTML =
      '<td><input type="checkbox" aria-label="Usar ' +
      esc(tr.name) +
      '"></td><td class="track-name"><span class="dot" style="background:' +
      palette[i % palette.length] +
      '"></span>' +
      esc(tr.name) +
      "<small>" +
      tr.notes.length.toLocaleString(I18n.locale) +
      ' notas</small></td><td><select aria-label="Instrumento de ' +
      esc(tr.name) +
      '"><option value="-1">Automático' +
      (tr.drum ? " · Percussão GM" : "") +
      "</option>" +
      (!tr.drum
        ? C.GM.map(
            (n, i) =>
              '<option value="' +
              i +
              '">' +
              String(i + 1).padStart(3, "0") +
              " · " +
              esc(n) +
              "</option>",
          ).join("")
        : "") +
      '</select></td><td><input type="range" min="0" max="127" step="1" aria-label="Volume de ' +
      esc(tr.name) +
      '"></td><td><input type="number" min="-48" max="48" value="0" aria-label="Semitons de ' +
      esc(tr.name) +
      '"></td>';
    const inputs = row.querySelectorAll("input,select");
    inputs[0].checked = v.enabled;
    inputs[1].value = v.program;
    inputs[1].disabled = tr.drum;
    inputs[2].value = v.volume;
    inputs[3].value = v.transpose;
    inputs[3].disabled = tr.drum;
    const update = (key, fn, el) =>
      el.addEventListener("change", () => {
        stopAudio();
        v[key] = fn(el);
        draw();
        renderScopes(x.song);
      });
    update("enabled", (e) => e.checked, inputs[0]);
    update(
      "program",
      (e) => {
        delete v.sfPreset;
        delete v.bank;
        delete v.gmProgram;
        row.querySelector(".sf-track") &&
          (row.querySelector(".sf-track").value = "-1");
        return Number(e.value);
      },
      inputs[1],
    );
    update("volume", (e) => Number(e.value), inputs[2]);
    update(
      "transpose",
      (e) => {
        const n = Number(e.value);
        e.value = String(Math.max(-48, Math.min(48, Math.round(n || 0))));
        return Number(e.value);
      },
      inputs[3],
    );
    if (fontState) {
      const sf = document.createElement("select");
      sf.className = "sf-track";
      sf.setAttribute("aria-label", "Preset SF2 de " + tr.name);
      sf.innerHTML =
        '<option value="-1">SF2 · Automático por programa</option>' +
        fontState.presets
          .map(
            (p) =>
              '<option data-i18n-skip="true" value="' +
              p.index +
              '">' +
              esc(p.name) +
              " · B" +
              p.bank +
              " / P" +
              (p.program + 1) +
              "</option>",
          )
          .join("");
      sf.value = v.sfPreset ?? -1;
      sf.onchange = () => {
        stopAudio();
        const index = Number(sf.value);
        if (index >= 0) {
          if (!(v.sfPreset >= 0)) v.gmProgram = v.program;
          const p = fontState.presets[index];
          v.sfPreset = index;
          v.program = p.program;
          v.bank = p.bank;
          inputs[1].value = v.program;
        } else {
          v.program = v.gmProgram ?? -1;
          delete v.sfPreset;
          delete v.bank;
          delete v.gmProgram;
          inputs[1].value = v.program;
        }
        draw();
        renderScopes(x.song);
      };
      row.cells[2].append(sf);
    }
    tbody.append(row);
  }
  const warns = [...s.warnings];
  const melodic = s.tracks.filter((t) => !t.drum).length,
    drum = s.tracks.filter((t) => t.drum).length;
  if (melodic > 15 || drum > 1)
    warns.push({
      message:
        "Esta música usa portas MIDI adicionais para isolar os controles. Players que ignoram portas podem misturar instrumentos; use um editor MIDI com suporte a portas ou exporte subconjuntos de pistas.",
    });
  $("warnings").hidden = !warns.length;
  $("warnings").open = !!warns.length;
  $("warning-title").textContent =
    warns.length +
    " aviso" +
    (warns.length === 1 ? "" : "s") +
    " de compatibilidade";
  $("warning-list").replaceChildren();
  for (const w of warns) {
    const li = document.createElement("li");
    li.textContent = w.message;
    $("warning-list").append(li);
  }
  $("play").disabled = !count || working || loading || fontLoading;
  $("download").disabled = !count || working;
  status(
    count
      ? warns.length
        ? "Conversão concluída com avisos. Confira as limitações abaixo."
        : "Conversão concluída. Confira as pistas e baixe o MIDI."
      : "Nenhuma nota compatível. Consulte os avisos; não será exportado um MIDI vazio.",
    count ? (warns.length ? "" : "ok") : "error",
  );
  draw();
  updateClock(0);
  if (x.error)
    status(
      "A reconversão falhou: " + x.error + " Resultado anterior preservado.",
      "error",
    );
}
