function refreshQueue() {
  const busy = working || loading;
  const target = $("files");
  target.replaceChildren();
  $("file-count").textContent = entries.length + " / 20";
  if (!entries.length) {
    const d = document.createElement("div");
    d.className = "empty-queue";
    d.textContent = "Suas músicas aparecerão aqui. Até 20 arquivos por lote.";
    target.append(d);
  }
  for (const x of entries) {
    const row = document.createElement("div");
    row.className =
      "file" +
      (x.id === selected ? " selected" : "") +
      (x.error ? " error" : "");
    const choose = document.createElement("button");
    choose.className = "choose";
    choose.title = x.name;
    const name = document.createElement("span");
    name.className = "filename";
    name.textContent = x.name;
    name.dataset.i18nSkip = "true";
    const info = document.createElement("small");
    info.textContent = x.error
      ? "Erro de leitura"
      : x.song
        ? `${x.song.tracks.length} pistas · ${fmt(x.song.duration)}`
        : x.processing
          ? "Convertendo…"
          : "Na fila";
    choose.append(name, info);
    choose.onclick = () => {
      stopAudio();
      selected = x.id;
      refreshQueue();
      render();
    };
    const rem = document.createElement("button");
    rem.className = "remove";
    rem.textContent = "×";
    rem.title = "Remover " + x.name;
    rem.setAttribute("aria-label", "Remover " + x.name);
    rem.disabled = busy;
    rem.onclick = () => {
      stopAudio();
      entries = entries.filter((e) => e.id !== x.id);
      totalBytes -= x.bytes.byteLength;
      if (selected === x.id) selected = entries[0]?.id || null;
      refreshQueue();
      render();
    };
    row.append(choose, rem);
    target.append(row);
  }
  $("export-all").disabled =
    busy || !entries.some((x) => x.song?.tracks.length);
  $("reconvert").disabled = busy || !selectedEntry();
  $("add-file").disabled = busy;
  $("browse").disabled = busy;
  $("demo").disabled = busy;
  $("demo-pcm").disabled = busy;
  $("demo-extra").disabled = busy;
  $("play").disabled =
    busy ||
    fontLoading ||
    !selectedEntry()?.song?.tracks.some((t) => t.notes.length);
}

function convertWorker(x, options) {
  return new Promise((resolve, reject) => {
    const url =
      workerURL ||
      (workerURL = URL.createObjectURL(
        new Blob([workerSource], { type: "application/javascript" }),
      ));
    try {
      worker = new Worker(url);
    } catch (err) {
      reject(
        Error(
          "Não foi possível iniciar o conversor. Abra o HTML salvo no computador em Chrome, Edge ou Firefox atualizado.",
        ),
      );
      return;
    }
    rejectCurrent = reject;
    worker.onmessage = (ev) => {
      worker.terminate();
      worker = null;
      rejectCurrent = null;
      ev.data.error ? reject(Error(ev.data.error)) : resolve(ev.data.song);
    };
    worker.onerror = (ev) => {
      worker.terminate();
      worker = null;
      rejectCurrent = null;
      reject(Error(ev.message || "Falha ao executar o conversor."));
    };
    try {
      const copy = x.bytes.slice();
      worker.postMessage({ bytes: copy, name: x.name, options }, [copy.buffer]);
    } catch (err) {
      worker.terminate();
      worker = null;
      rejectCurrent = null;
      reject(err);
    }
  });
}

async function processList(list) {
  if (working) return;
  stopAudio();
  working = true;
  cancelBatch = false;
  cancelButton.hidden = false;
  $("busybar").hidden = false;
  refreshQueue();
  const options = readOptions();
  for (let i = 0; i < list.length; i++) {
    if (cancelBatch) break;
    const x = list[i];
    x.processing = true;
    x.error = null;
    status(`Convertendo ${i + 1} de ${list.length}: ${x.name}`, "busy");
    refreshQueue();
    try {
      const converted = await convertWorker(x, options);
      const previous = x.song,
        kept = {};
      for (const seg of converted.pcmSegments || []) {
        const old = previous?.pcmSegments?.[seg.id];
        if (
          old &&
          old.chip === seg.chip &&
          Math.abs(old.start - seg.start) < 1 &&
          Math.abs(old.end - seg.end) < 1 &&
          x.pcmSettings?.[seg.id]
        )
          kept[seg.id] = x.pcmSettings[seg.id];
      }
      x.pcmSettings = kept;
      x.pcmPage = 0;
      x.song = C.mapPCM(converted, kept);
      x.parseOptions = { ...options };
      x.settings = x.settings || {};
      x.error = null;
    } catch (err) {
      x.error = err.message;
    }
    x.processing = false;
    if (selected === x.id) render();
    refreshQueue();
  }
  working = false;
  cancelButton.hidden = true;
  $("busybar").hidden = true;
  refreshQueue();
  render();
  if (cancelBatch)
    status(
      "Conversão cancelada. Os arquivos já concluídos continuam disponíveis.",
    );
}

async function addFiles(files) {
  if (working || loading) return;
  loading = true;
  refreshQueue();
  selectView("convert");
  const list = [],
    rejected = [],
    names = [...files].map((file) => file.name);
  const reject = (message) => {
    rejected.push(message);
    status(message, "error", names);
  };
  try {
    for (const file of files) {
      if (!/\.(vgm|vgz|gym|gz)$/i.test(file.name)) {
        reject(
          "Adicionar músicas aceita somente .vgm, .vgz, .vgm.gz ou .gym. Para uma soundfont, use Carregar SF2.",
        );
        continue;
      }
      if (entries.length >= 20) {
        reject("Limite de 20 arquivos. Remova alguns para adicionar outros.");
        break;
      }
      if (
        file.size > 64 * 1024 * 1024 ||
        file.size + totalBytes > 256 * 1024 * 1024
      ) {
        reject(file.name + ": limite de tamanho excedido.");
        continue;
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const x = {
          id: crypto.randomUUID
            ? crypto.randomUUID()
            : Date.now() + "-" + entries.length,
          name: file.name,
          bytes,
          song: null,
          settings: {},
          error: null,
        };
        entries.push(x);
        totalBytes += bytes.length;
        list.push(x);
      } catch (error) {
        reject("Falha ao ler " + file.name + ": " + error.message);
      }
    }
  } finally {
    loading = false;
    refreshQueue();
  }
  if (list.length) {
    selected = list[0].id;
    refreshQueue();
    await processList(list);
  }
  if (rejected.length)
    status(
      "Arquivos ignorados: " +
        rejected.length +
        ". " +
        [...new Set(rejected)].join(" "),
      "error",
      names,
    );
}
