const $ = (id) => document.getElementById(id),
  C = VGMCore,
  palette = [
    "#579cff",
    "#f65975",
    "#d6b66c",
    "#a38cff",
    "#3fd4c3",
    "#ee965f",
    "#a9bcdf",
  ];

let entries = [],
  selected = null,
  worker = null,
  working = false,
  loading = false,
  cancelBatch = false,
  totalBytes = 0,
  audio = null,
  playState = null,
  audioTicket = 0;

const fmt = (s) =>
    Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0"),
  esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

const status = (msg, kind = "", names = []) => {
  I18n.protect([
    ...entries.map((e) => e.name),
    ...names,
    ...(fontState ? [fontState.name] : []),
  ]);
  $("status").textContent = msg;
  $("status").className = kind;
};

const selectedEntry = () => entries.find((x) => x.id === selected);

const readOptions = () => ({
  loops: Number($("loops").value),
  pitchMode: $("pitch").value,
  gymRate: Number($("gym-rate").value),
});

const exportOptions = () => ({
  bpm: Number($("bpm").value),
  transpose: Number($("transpose").value),
});

const workerSource =
  $("vgm-core").textContent + "\n" + $("worker-protocol").textContent;

let rejectCurrent = null,
  workerURL = null;

const cancelButton = document.createElement("button");

function setting(x, tr) {
  return (
    x.settings[tr.id] ||
    (x.settings[tr.id] = {
      enabled: true,
      program: -1,
      volume: 100,
      transpose: 0,
    })
  );
}

let rollCache = null;

const fileBase = (name) =>
  name
    .replace(/\.(vgm\.gz|vgz|vgm|gym|gz)$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 140) || "musica";

let fontState = null,
  sampler = null,
  fontLoading = false,
  fontTicket = 0,
  master = null,
  buses = new Map(),
  scopeCards = new Map(),
  scopePage = 0,
  raf = null,
  lastFrame = 0,
  rollGeometry = null,
  noiseBuffer = null,
  pcmPreviewCard = null;

const noteName = (k) =>
  ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"][
    ((k % 12) + 12) % 12
  ] +
  (Math.floor(k / 12) - 1);
