function draw(force = true) {
  const s = selectedEntry()?.song,
    canvas = $("roll");
  if (!s || $("view-convert").hidden) return;
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const scale = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.round(r.width * scale),
    ch = 260 * scale;
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
    force = true;
    rollCache = null;
  }
  const g = canvas.getContext("2d");
  g.setTransform(scale, 0, 0, scale, 0, 0);
  const w = r.width,
    h = 260,
    left = 39,
    right = w - 12,
    top = 24,
    bottom = h - 18;
  if (!force && rollCache && rollCache.width === canvas.width) {
    g.drawImage(rollCache, 0, 0, w, h);
    highlightNotes(g);
    const px = left + (Number($("seek").value) / 1000) * (right - left);
    g.strokeStyle = "#ff607e";
    g.beginPath();
    g.moveTo(px, top);
    g.lineTo(px, bottom);
    g.stroke();
    return;
  }
  g.fillStyle = "#101928";
  g.fillRect(0, 0, w, h);
  let lo = 128,
    hi = 0;
  const x = selectedEntry();
  for (const t of s.tracks) {
    const st = setting(x, t);
    for (const n of t.notes) {
      const k =
        n.key + (t.drum ? 0 : Number($("transpose").value) + st.transpose);
      lo = Math.min(lo, k);
      hi = Math.max(hi, k);
    }
  }
  if (lo > hi) {
    lo = 48;
    hi = 84;
  }
  lo = Math.max(0, lo - 2);
  hi = Math.min(127, hi + 2);
  const range = Math.max(12, hi - lo + 1),
    rowH = (bottom - top) / range;
  g.font = "10px Segoe UI, sans-serif";
  for (let k = lo; k <= hi; k++) {
    const y = bottom - (k - lo + 1) * rowH;
    if (k % 12 === 0) {
      g.strokeStyle = "#2b394d";
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(right, y);
      g.stroke();
      g.fillStyle = "#91a1b7";
      g.fillText("C" + (Math.floor(k / 12) - 1), 4, y + rowH + 2);
    } else {
      g.strokeStyle = "#1b283a";
      g.beginPath();
      g.moveTo(left, y);
      g.lineTo(right, y);
      g.stroke();
    }
  }
  const duration = Math.max(s.duration, 0.1);
  for (let i = 0; i <= 8; i++) {
    const px = left + ((right - left) * i) / 8;
    g.strokeStyle = "#273449";
    g.beginPath();
    g.moveTo(px, top);
    g.lineTo(px, bottom);
    g.stroke();
    g.fillStyle = "#91a1b7";
    g.fillText(fmt((duration * i) / 8), Math.min(px, right - 22), 14);
  }
  for (let j = 0; j < s.tracks.length; j++) {
    const t = s.tracks[j],
      st = setting(x, t);
    g.fillStyle = palette[j % palette.length];
    g.globalAlpha = st.enabled ? 0.9 : 0.15;
    const stride = Math.max(
      1,
      Math.ceil(t.notes.length / Math.max(400, 12000 / s.tracks.length)),
    );
    for (let z = 0; z < t.notes.length; z += stride) {
      const n = t.notes[z],
        k = n.key + (t.drum ? 0 : Number($("transpose").value) + st.transpose),
        a = left + (n.start / s.samples) * (right - left),
        b = left + (n.end / s.samples) * (right - left),
        y = bottom - (k - lo + 1) * rowH;
      g.fillRect(a, y + 1, Math.max(1, b - a), Math.max(2, rowH - 1));
    }
  }
  rollGeometry = { left, right, bottom, rowH, lo, samples: s.samples };
  g.globalAlpha = 1;
  rollCache = document.createElement("canvas");
  rollCache.width = canvas.width;
  rollCache.height = canvas.height;
  rollCache.getContext("2d").drawImage(canvas, 0, 0);
  const px = left + (Number($("seek").value) / 1000) * (right - left);
  g.strokeStyle = "#ff607e";
  g.beginPath();
  g.moveTo(px, top);
  g.lineTo(px, bottom);
  g.stroke();
}

function highlightNotes(g) {
  if (!$("animations").checked || !playState?.active || !rollGeometry) return;
  const q = rollGeometry;
  for (const o of playState.active.values()) {
    const n = o.n,
      k =
        n.key + (o.t.drum ? 0 : Number($("transpose").value) + o.st.transpose),
      a = q.left + (n.start / q.samples) * (q.right - q.left),
      b = q.left + (n.end / q.samples) * (q.right - q.left),
      y = q.bottom - (k - q.lo + 1) * q.rowH;
    g.fillStyle = "#fff";
    g.shadowColor = "#ff5275";
    g.shadowBlur = 9;
    g.fillRect(a, y, Math.max(3, b - a), Math.max(3, q.rowH));
  }
  g.shadowBlur = 0;
}

function updateClock(time) {
  const s = selectedEntry()?.song;
  $("clock").textContent = fmt(time) + " / " + fmt(s?.duration || 0);
}
