function renderFont() {
  $("play").disabled =
    working ||
    loading ||
    fontLoading ||
    !selectedEntry()?.song?.tracks.some((t) => t.notes.length);
  $("sf-name").dataset.i18nSkip = String(!!fontState);
  $("sf-name").textContent = fontState
    ? fontState.name
    : "Soundfont · somente SF2";
  $("sf-status").textContent = fontLoading
    ? "Lendo e validando a soundfont…"
    : fontState
      ? fontState.presets.length +
        " presets · " +
        fontState.samples.length +
        " samples · " +
        (fontState.size / 1024 / 1024).toFixed(1) +
        " MB"
      : "Arraste somente uma .sf2 aqui ou clique em Carregar SF2.";
  $("sf-remove").disabled = !fontState || fontLoading;
  $("sf-load").disabled = fontLoading;
  $("audio-engine").querySelector("[value=sf2]").disabled = !fontState;
}

function resetSFSettings() {
  for (const x of entries)
    for (const v of Object.values(x.settings)) {
      if (v.sfPreset >= 0) v.program = v.gmProgram ?? -1;
      delete v.sfPreset;
      delete v.bank;
      delete v.gmProgram;
    }
}

async function loadSF2(file) {
  if (!file) return;
  if (!/\.sf2$/i.test(file.name)) {
    status(
      "Carregar SF2 aceita somente soundfonts .sf2. Para uma música, use Adicionar músicas.",
      "error",
    );
    return;
  }
  const token = ++fontTicket;
  fontLoading = true;
  stopAudio();
  renderFont();
  try {
    if (file.size > 256 * 1024 * 1024) throw Error("Limite da SF2: 256 MB.");
    const data = await file.arrayBuffer();
    if (token !== fontTicket) return;
    const parsed = SF2.parse(data);
    resetSFSettings();
    fontState = parsed;
    sampler = null;
    $("audio-engine").value = "sf2";
    render();
    status(
      "Soundfont carregada: " +
        parsed.name +
        " · " +
        parsed.presets.length +
        " presets disponíveis.",
      "ok",
    );
  } catch (e) {
    status(
      "SF2: " +
        e.message +
        (fontState ? " Soundfont anterior preservada." : ""),
      "error",
    );
  } finally {
    if (token === fontTicket) {
      fontLoading = false;
      renderFont();
    }
  }
}
