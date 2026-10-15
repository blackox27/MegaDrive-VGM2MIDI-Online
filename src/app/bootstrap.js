"use strict";

document
  .querySelectorAll("nav button")
  .forEach((b) =>
    b.addEventListener("click", () => selectView(b.dataset.view)),
  );

cancelButton.textContent = "Cancelar conversão";

cancelButton.className = "small";

cancelButton.style.marginBottom = "14px";

cancelButton.hidden = true;

$("busybar").after(cancelButton);

cancelButton.onclick = () => {
  cancelBatch = true;
  if (worker) {
    worker.terminate();
    worker = null;
    rejectCurrent?.(Error("Conversão cancelada."));
    rejectCurrent = null;
  }
  status("Conversão cancelada.", "");
};

$("add-file").onclick = $("browse").onclick = () => $("file-input").click();

$("file-input").onchange = async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  await addFiles(files);
};

$("demo-extra").onclick = () =>
  addFiles([new File([C.demoSegaVGM()], "Demo-SegaPCM.vgm")]);

$("demo-pcm").onclick = () =>
  addFiles([
    new File([C.demoPCMVGM()], "Demo-PCM-Notas.vgm", {
      type: "application/octet-stream",
    }),
  ]);

$("demo").onclick = () =>
  addFiles([
    new File([C.demoVGM()], "Demo-Chip-Notes.vgm", {
      type: "application/octet-stream",
    }),
  ]);

for (const event of ["dragover", "dragenter"])
  $("drop").addEventListener(event, (e) => {
    e.preventDefault();
    $("drop").classList.add("drag");
  });

for (const event of ["dragleave", "drop"])
  $("drop").addEventListener(event, (e) => {
    e.preventDefault();
    $("drop").classList.remove("drag");
  });

$("drop").addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));

for (const event of ["dragover", "dragenter"])
  $("sf-drop").addEventListener(event, (e) => {
    e.preventDefault();
    $("sf-drop").classList.add("drag");
  });

for (const event of ["dragleave", "drop"])
  $("sf-drop").addEventListener(event, (e) => {
    e.preventDefault();
    $("sf-drop").classList.remove("drag");
  });

$("sf-drop").addEventListener("drop", (e) => {
  const files = [...e.dataTransfer.files];
  if (files.length !== 1) {
    status("Carregar SF2 aceita uma única soundfont .sf2 por vez.", "error");
    return;
  }
  loadSF2(files[0]);
});

window.addEventListener("dragover", (e) => e.preventDefault());

window.addEventListener("drop", (e) => e.preventDefault());

$("reconvert").onclick = () => {
  const x = selectedEntry();
  if (x) processList([x]);
};

for (const id of ["bpm", "transpose", "loops", "pitch", "gym-rate"])
  $(id).addEventListener("change", () => {
    stopAudio();
    if (["loops", "pitch", "gym-rate"].includes(id) && selectedEntry()?.song)
      status(
        "Opções alteradas. Clique em Reconverter selecionado para aplicá-las.",
      );
    draw();
  });

window.addEventListener("resize", draw);

$("diagnostic").onclick = () => {
  const x = selectedEntry();
  if (x)
    save(
      diagnostic(x),
      fileBase(x.name) + "-diagnostico.txt",
      "text/plain;charset=utf-8",
    );
};

$("download").onclick = () => {
  try {
    const x = selectedEntry(),
      m = C.exportMIDI(x.song, exportOptions(), x.settings);
    save(m.bytes, fileBase(x.name) + ".mid", "audio/midi");
    status(
      "MIDI gerado: " +
        m.tracks +
        " pistas" +
        (m.ports > 1
          ? " em " + m.ports + " portas. Verifique o suporte do seu editor."
          : "."),
      "ok",
    );
  } catch (err) {
    status(err.message, "error");
  }
};

$("export-all").onclick = () => {
  try {
    const files = [],
      errors = [];
    let i = 0;
    for (const x of entries) {
      if (!x.song?.tracks.length) {
        errors.push(x.name + ": " + (x.error || "Sem notas"));
        continue;
      }
      try {
        const m = C.exportMIDI(x.song, exportOptions(), x.settings);
        const base = String(++i).padStart(2, "0") + "-" + fileBase(x.name);
        files.push(
          { name: base + ".mid", data: m.bytes },
          { name: base + "-diagnostico.txt", data: diagnostic(x) },
        );
      } catch (err) {
        errors.push(x.name + ": " + err.message);
      }
    }
    if (!files.length)
      throw Error(errors.join("\n") || "Nenhum MIDI disponível.");
    files.push({
      name: "LEIA-ME.txt",
      data:
        "VGM2MID Web — MIDIs e diagnósticos\r\n\r\n" +
        (errors.length
          ? "Não exportados:\r\n" + errors.join("\r\n")
          : "Todos os arquivos com notas foram exportados."),
    });
    save(zipStored(files), "VGM2MID-MIDIs.zip", "application/zip");
    status(
      i +
        " MIDI(s) no ZIP." +
        (errors.length
          ? " " +
            errors.length +
            " arquivo(s) não exportado(s); consulte LEIA-ME.txt."
          : ""),
      "ok",
    );
  } catch (err) {
    status(err.message, "error");
  }
};

window.addEventListener("error", (e) =>
  status("Erro inesperado: " + e.message, "error"),
);

window.addEventListener("unhandledrejection", (e) =>
  status(
    "Não foi possível concluir: " + (e.reason?.message || e.reason),
    "error",
  ),
);

$("play").onclick = play;

$("pause").onclick = () => {
  const pos = Number($("seek").value);
  stopAudio();
  $("seek").value = String(pos);
  $("play").textContent = "▶ Continuar";
  draw(false);
  status("Reprodução pausada.");
};

$("stop").onclick = () => {
  stopAudio();
  $("seek").value = "0";
  updateClock(0);
  draw(false);
};

$("seek").oninput = () => {
  stopAudio();
  updateClock(
    (Number($("seek").value) / 1000) * (selectedEntry()?.song?.duration || 0),
  );
  draw(false);
};

document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopAudio();
});

$("animations").onchange = () => {
  document.body.classList.toggle("reduce-motion", !$("animations").checked);
  draw(false);
};

if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
  $("animations").checked = false;
  document.body.classList.add("reduce-motion");
}

$("sf-load").onclick = () => $("sf-input").click();

$("sf-input").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  await loadSF2(f);
};

$("sf-remove").onclick = () => {
  fontTicket++;
  stopAudio();
  resetSFSettings();
  fontState = null;
  sampler = null;
  $("audio-engine").value = "synth";
  renderFont();
  render();
  status("Soundfont removida. Prévia com síntese simples.");
};

$("audio-engine").onchange = () => {
  stopAudio();
  renderScopes(selectedEntry()?.song);
  status(
    $("audio-engine").value === "sf2"
      ? "Prévia usando a soundfont carregada."
      : "Prévia usando síntese simples.",
  );
};

renderFont();

// Accessibility and keyboard transport. Input controls retain their native keyboard behavior.
document.addEventListener("keydown", (event) => {
  if (
    event.code !== "Space" ||
    event.repeat ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.target.closest("input,select,textarea,button,a,[contenteditable]")
  )
    return;
  if (
    $("view-convert").hidden ||
    !selectedEntry()?.song ||
    working ||
    loading ||
    fontLoading
  )
    return;
  event.preventDefault();
  if (playState && !playState.audition) $("pause").click();
  else play();
});
const bulk = (enabled) => {
  const x = selectedEntry();
  if (!x?.song || working) return;
  stopAudio();
  for (const tr of x.song.tracks) setting(x, tr).enabled = enabled;
  const seek = $("seek").value;
  render();
  $("seek").value = seek;
};
$("tracks-enable").onclick = () => bulk(true);
$("tracks-disable").onclick = () => bulk(false);
window.addEventListener("vgm-language", () => {
  const s = selectedEntry()?.song;
  if (s)
    $("stat-notes").textContent = s.tracks
      .reduce((sum, t) => sum + t.notes.length, 0)
      .toLocaleString(I18n.locale);
});
window.addEventListener("pagehide", () => {
  stopAudio();
  if (worker) {
    worker.terminate();
    worker = null;
    rejectCurrent?.(Error("Conversão cancelada."));
    rejectCurrent = null;
  }
  if (workerURL) {
    URL.revokeObjectURL(workerURL);
    workerURL = null;
  }
});
I18n.init();
