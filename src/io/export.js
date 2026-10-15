function save(data, name, type) {
  const url = URL.createObjectURL(new Blob([data], { type })),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function diagnostic(x) {
  const s = x.song;
  return [
    "VGM2MID WEB 3.2 — DIAGNÓSTICO",
    "Arquivo: " + x.name,
    "Resultado: " + (x.error || "convertido"),
    s ? "Formato: " + s.format + " " + s.version : "",
    s ? "Duração: " + s.duration.toFixed(6) + " s" : "",
    s ? "Comandos: " + s.commands : "",
    s ? "Pistas: " + s.tracks.length : "",
    "Opções de leitura: " + JSON.stringify(x.parseOptions || {}),
    "Opções de MIDI: " + JSON.stringify(exportOptions()),
    "Soundfont: " + (fontState?.name || "nenhuma"),
    "Prévia: " + $("audio-engine").value,
    "Ajustes de pistas: " + JSON.stringify(x.settings),
    "Ajustes PCM: " + JSON.stringify(x.pcmSettings || {}),
    "Trechos PCM: " +
      JSON.stringify(
        s?.pcmSegments?.map((p) => ({
          id: p.id,
          source: p.source,
          start: p.start / C.SR,
          end: p.end / C.SR,
          kind: p.analysis.kind,
          note: p.analysis.note,
          periodicity: p.analysis.confidence,
          resolution: p.analysis.resolution,
        })),
      ),
    "",
    "AVISOS",
    ...(s?.warnings.map((w) => "- " + w.message) || []),
    "",
    "Conversão aproximada: MIDI não preserva os timbres/samples originais. Prévia: " +
      (fontState && $("audio-engine").value === "sf2"
        ? fontState.name
        : "síntese simples") +
      ".",
    "VGM2MID original: Paul Jensen, atualizações Valley Bell. Esta versão é independente.",
  ]
    .map((line) => I18n.text(line))
    .join("\r\n");
}

function zipStored(files) {
  const table = Uint32Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    }),
    parts = [],
    central = [];
  let offset = 0;
  const te = new TextEncoder();
  const le = (n, k) =>
    Array.from({ length: k }, (_, i) => (n >>> (i * 8)) & 255);
  for (const f of files) {
    const n = te.encode(f.name),
      b = typeof f.data === "string" ? te.encode(f.data) : f.data;
    let crc = 0xffffffff;
    for (const byte of b) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const hdr = new Uint8Array([
      80,
      75,
      3,
      4,
      ...le(20, 2),
      ...le(0x800, 2),
      0,
      0,
      0,
      0,
      33,
      0,
      ...le(crc, 4),
      ...le(b.length, 4),
      ...le(b.length, 4),
      ...le(n.length, 2),
      0,
      0,
      ...n,
    ]);
    parts.push(hdr, b);
    const cen = new Uint8Array([
      80,
      75,
      1,
      2,
      ...le(20, 2),
      ...le(20, 2),
      ...le(0x800, 2),
      0,
      0,
      0,
      0,
      33,
      0,
      ...le(crc, 4),
      ...le(b.length, 4),
      ...le(b.length, 4),
      ...le(n.length, 2),
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
      0,
      0,
      ...le(offset, 4),
      ...n,
    ]);
    central.push(cen);
    offset += hdr.length + b.length;
  }
  const csize = central.reduce((s, b) => s + b.length, 0);
  return new Blob(
    [
      ...parts,
      ...central,
      new Uint8Array([
        80,
        75,
        5,
        6,
        0,
        0,
        0,
        0,
        ...le(files.length, 2),
        ...le(files.length, 2),
        ...le(csize, 4),
        ...le(offset, 4),
        0,
        0,
      ]),
    ],
    { type: "application/zip" },
  );
}
