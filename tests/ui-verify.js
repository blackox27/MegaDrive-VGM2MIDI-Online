"use strict";
// Local DOM unit tests; no browser is launched and no website is accessed.
const { JSDOM, VirtualConsole } = require("jsdom");
const { Worker: NodeWorker } = require("node:worker_threads");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
const downloads = [],
  errors = [],
  blobs = new Map(),
  results = [];
let urlSeq = 0,
  audioStarts = 0,
  scopeReads = 0;
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (e) => errors.push(e.message));
const ctx = () => ({
  paths: [],
  path: [],
  setTransform() {},
  scale() {},
  fillRect() {
    this.paths = [];
  },
  beginPath() {
    this.path = [];
  },
  moveTo(x, y) {
    this.path.push([x, y]);
  },
  lineTo(x, y) {
    this.path.push([x, y]);
  },
  stroke() {
    this.paths.push(this.path.slice());
  },
  fillText() {},
  drawImage() {},
});
const html = fs.readFileSync("VGM2MID-MegaDrive-3.2.html", "utf8");
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://unit-test.invalid/",
  virtualConsole,
  beforeParse(w) {
    w.TextEncoder = TextEncoder;
    w.TextDecoder = TextDecoder;
    w.Blob = Blob;
    w.File = File;
    w.DecompressionStream = DecompressionStream;
    w.URL.createObjectURL = (blob) => {
      const id = "blob:test-" + ++urlSeq;
      blobs.set(id, blob);
      return id;
    };
    w.URL.revokeObjectURL = (id) => blobs.delete(id);
    w.HTMLAnchorElement.prototype.click = function () {
      if (this.download)
        downloads.push({ name: this.download, blob: blobs.get(this.href) });
    };
    w.HTMLCanvasElement.prototype.getContext = function () {
      return this._context || (this._context = ctx());
    };
    w.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
      return {
        width: 880,
        height: 230,
        left: 0,
        top: 0,
        right: 880,
        bottom: 230,
      };
    };
    w.Worker = class {
      constructor(url) {
        this.queue = [];
        this.dead = false;
        const blob = blobs.get(url);
        blob.text().then((code) => {
          if (this.dead) return;
          this.node = new NodeWorker(
            "const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;self.postMessage=data=>parentPort.postMessage(data);" +
              code +
              "\nparentPort.on('message',data=>self.onmessage({data}));",
            { eval: true },
          );
          this.node.on("message", (data) => this.onmessage?.({ data }));
          this.node.on("error", (e) => this.onerror?.(e));
          for (const data of this.queue) this.node.postMessage(data);
          this.queue = [];
        });
      }
      postMessage(data) {
        this.node ? this.node.postMessage(data) : this.queue.push(data);
      }
      terminate() {
        this.dead = true;
        this.node?.terminate();
      }
    };
    const param = () => ({
      setValueAtTime(v, t) {
        assert.ok(Number.isFinite(v) && Number.isFinite(t));
      },
      linearRampToValueAtTime(v, t) {
        assert.ok(Number.isFinite(v) && Number.isFinite(t));
      },
    });
    w.AudioContext = class {
      constructor() {
        this.started = performance.now();
        this.sampleRate = 44100;
        this.destination = {};
      }
      get currentTime() {
        return (performance.now() - this.started) / 1000;
      }
      async resume() {}
      createOscillator() {
        return {
          frequency: param(),
          connect() {},
          disconnect() {},
          start() {
            audioStarts++;
          },
          stop() {},
        };
      }
      createBufferSource() {
        const n = this.createOscillator();
        n.playbackRate = param();
        return n;
      }
      createAnalyser() {
        return {
          fftSize: 512,
          connect() {},
          disconnect() {},
          getFloatTimeDomainData(a) {
            scopeReads++;
            for (let i = 0; i < a.length; i++)
              a[i] = 0.002 * Math.sin((i / 44100) * 55 * 2 * Math.PI + 0.63);
          },
        };
      }
      createDynamicsCompressor() {
        return {
          threshold: { value: 0 },
          ratio: { value: 0 },
          connect() {},
          disconnect() {},
        };
      }
      createGain() {
        return { gain: param(), connect() {}, disconnect() {} };
      }
      createStereoPanner() {
        return { pan: param(), connect() {}, disconnect() {} };
      }
      createBuffer(ch, len, rate = 44100) {
        const a = new Float32Array(len);
        return {
          length: len,
          duration: len / rate,
          sampleRate: rate,
          getChannelData() {
            return a;
          },
        };
      }
    };
  },
});
const w = dom.window,
  d = w.document,
  $ = (id) => d.getElementById(id),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 300; i++) {
    if (fn()) return;
    await sleep(10);
  }
  throw Error("UI timeout: " + $("status").textContent);
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: "PASS" });
  } catch (e) {
    results.push({ name, status: "FAIL", error: e.stack });
    console.error("FAIL", name, e.message);
  }
}
const spread = (canvas) => {
  const path = canvas._context.paths.at(-1);
  return (
    Math.max(...path.map((p) => p[1])) - Math.min(...path.map((p) => p[1]))
  );
};
const dropFiles = (id, files) => {
  const e = new w.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "dataTransfer", { value: { files } });
  $(id).dispatchEvent(e);
};
const inputFiles = (id, files) => {
  Object.defineProperty($(id), "files", { value: files, configurable: true });
  $(id).dispatchEvent(new w.Event("change", { bubbles: true }));
};
const chooseFile = async (files) => {
  Object.defineProperty($("file-input"), "files", {
    value: files,
    configurable: true,
  });
  $("file-input").dispatchEvent(new w.Event("change", { bubbles: true }));
  await until(() => !$("busybar").hidden);
  await until(() => $("busybar").hidden);
};
(async () => {
  await test("Inicialização do HTML inteiro sem erro de script", () => {
    assert.equal(errors.length, 0);
    assert.equal($("result").hidden, true);
    assert.ok($("status").textContent.includes("Pronto"));
  });
  await test("Seletores independentes têm filtros exclusivos e botões próprios", () => {
    assert.equal($("file-input").accept, ".vgm,.vgz,.gz,.gym");
    assert.equal($("sf-input").accept, ".sf2");
    let music = 0,
      font = 0;
    $("file-input").click = () => music++;
    $("sf-input").click = () => font++;
    $("add-file").click();
    assert.equal(music, 1);
    assert.equal(font, 0);
    $("sf-load").click();
    assert.equal(font, 1);
    assert.equal(music, 1);
  });
  await test("Adicionar músicas rejeita SF2 sem ler ou carregar a fonte", async () => {
    const file = {
      name: "fonte.sf2",
      size: 4,
      arrayBuffer() {
        throw Error("Não deve ler");
      },
    };
    inputFiles("file-input", [file]);
    await sleep(10);
    assert.ok($("status").textContent.includes("Para uma soundfont"));
    assert.equal($("file-count").textContent, "0 / 20");
    assert.equal($("audio-engine").value, "synth");
    assert.equal($("file-input").value, "");
  });
  await test("Carregar SF2 rejeita VGM sem abrir ou converter música", async () => {
    inputFiles("sf-input", [
      {
        name: "musica.vgm",
        arrayBuffer() {
          throw Error("Não deve ler");
        },
      },
    ]);
    await sleep(10);
    assert.ok($("status").textContent.includes("Para uma música"));
    assert.equal($("file-count").textContent, "0 / 20");
    assert.equal($("audio-engine").value, "synth");
  });
  await test("Áreas de arrastar arquivos também mantêm os formatos separados", () => {
    dropFiles("drop", [{ name: "fonte.sf2", size: 4 }]);
    assert.ok($("status").textContent.includes("Para uma soundfont"));
    dropFiles("sf-drop", [{ name: "musica.vgm" }]);
    assert.ok($("status").textContent.includes("Para uma música"));
    dropFiles("sf-drop", [{ name: "um.sf2" }, { name: "dois.sf2" }]);
    assert.ok($("status").textContent.includes("única soundfont"));
    assert.equal($("file-count").textContent, "0 / 20");
  });
  await test("Demonstração: clique, Worker real de Node, 4 pistas e 64 notas", async () => {
    $("demo").click();
    await until(() => $("result").hidden === false);
    assert.equal($("stat-tracks").textContent, "4");
    assert.equal($("stat-notes").textContent, "64");
    assert.equal($("track-body").children.length, 4);
    assert.ok($("status").textContent.includes("concluída"));
  });
  await test("MIDI baixável contém assinatura MThd", async () => {
    $("download").click();
    assert.ok(downloads.at(-1).name.endsWith(".mid"));
    const b = Buffer.from(await downloads.at(-1).blob.arrayBuffer());
    assert.equal(b.toString("ascii", 0, 4), "MThd");
    fs.writeFileSync("tests/fixtures/ui-download.mid", b);
  });
  await test("Instrumento e transposição de pista alteram MIDI", async () => {
    const row = $("track-body").firstElementChild,
      select = row.querySelector("select");
    select.value = "40";
    select.dispatchEvent(new w.Event("change"));
    const n = row.querySelector("input[type=number]");
    n.value = "12";
    n.dispatchEvent(new w.Event("change"));
    $("download").click();
    const b = Buffer.from(await downloads.at(-1).blob.arrayBuffer());
    assert.ok(b.includes(Buffer.from([0xc0, 40])));
    assert.ok(b.includes(Buffer.from([0x90, 72, 100])));
  });
  await test("Desabilitar todas as pistas mostra erro, sem download vazio", () => {
    const inputs = $("track-body").querySelectorAll("input[type=checkbox]");
    for (const x of inputs) {
      x.checked = false;
      x.dispatchEvent(new w.Event("change"));
    }
    const n = downloads.length;
    $("download").click();
    assert.equal(downloads.length, n);
    assert.ok($("status").textContent.includes("pistas ativas"));
    for (const x of inputs) {
      x.checked = true;
      x.dispatchEvent(new w.Event("change"));
    }
  });
  await test("Prévia e parada acionam API de áudio simulada", async () => {
    $("play").click();
    await until(() => audioStarts > 0);
    assert.equal($("stop").disabled, false);
    $("stop").click();
    assert.equal($("stop").disabled, true);
  });
  await test("BPM inválido bloqueia exportação", () => {
    $("bpm").value = "0";
    const n = downloads.length;
    $("download").click();
    assert.equal(downloads.length, n);
    assert.ok($("status").textContent.includes("BPM"));
    $("bpm").value = "137";
  });
  await test("Navegação entre conversor, ajuda e análise", () => {
    d.querySelector("[data-view=compat]").click();
    assert.equal($("view-compat").hidden, false);
    assert.equal($("view-convert").hidden, true);
    d.querySelector("[data-view=audit]").click();
    assert.equal($("view-audit").hidden, false);
    d.querySelector("[data-view=convert]").click();
    assert.equal($("view-convert").hidden, false);
  });
  await test("VGZ importado pelo input e processado", async () => {
    await chooseFile([
      new File(
        [fs.readFileSync("tests/fixtures/compactado.vgz")],
        "compactado.vgz",
      ),
    ]);
    assert.equal($("stat-tracks").textContent, "1");
    assert.equal($("stat-time").textContent, "0:01");
  });
  await test("Loop 3 passagens: reconversão pelo botão", async () => {
    await chooseFile([
      new File([fs.readFileSync("tests/fixtures/loop.vgm")], "loop.vgm"),
    ]);
    $("loops").value = "3";
    $("loops").dispatchEvent(new w.Event("change"));
    assert.ok($("status").textContent.includes("Reconverter"));
    $("reconvert").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.equal($("stat-notes").textContent, "4");
  });
  await test("GD3 com markup é exibido como texto inerte", async () => {
    await chooseFile([
      new File([fs.readFileSync("tests/fixtures/unicode.vgm")], "unicode.vgm"),
    ]);
    assert.ok($("song-title").textContent.includes("<img"));
    assert.equal($("song-title").querySelectorAll("img").length, 0);
  });
  await test("Arquivo truncado apresenta erro e não mostra resultado anterior", async () => {
    await chooseFile([new File([new Uint8Array([1, 2, 3])], "invalido.vgm")]);
    assert.equal($("result").hidden, true);
    assert.ok($("status").classList.contains("error"));
  });
  await test("Cancelamento termina Worker e restaura os controles", async () => {
    const big = Buffer.alloc(12_000_065, 0x70);
    big.write("Vgm ");
    big.writeUInt32LE(big.length - 4, 4);
    big.writeUInt32LE(0x150, 8);
    big.fill(0, 12, 64);
    big.writeUInt32LE(12, 0x34);
    big[big.length - 1] = 0x66;
    Object.defineProperty($("file-input"), "files", {
      value: [new File([big], "grande.vgm")],
      configurable: true,
    });
    $("file-input").dispatchEvent(new w.Event("change"));
    await until(() => !$("busybar").hidden);
    [...d.querySelectorAll("button")]
      .find((x) => x.textContent === "Cancelar conversão")
      .click();
    await until(() => $("busybar").hidden);
    assert.ok($("status").textContent.includes("cancelada"));
    assert.equal($("browse").disabled, false);
  });
  await test("ZIP do lote exclui erros e inclui diagnósticos", async () => {
    $("export-all").click();
    const out = downloads.at(-1);
    assert.equal(out.name, "VGM2MID-MIDIs.zip");
    fs.writeFileSync(
      "tests/fixtures/ui-download.zip",
      Buffer.from(await out.blob.arrayBuffer()),
    );
    assert.ok($("status").textContent.includes("não exportado"));
  });
  await test("Remoção de arquivo e contador da fila", () => {
    const n = $("files").children.length;
    $("files").querySelector("button.remove").click();
    assert.equal($("files").children.length, n - 1);
    assert.equal($("file-count").textContent, n - 1 + " / 20");
  });
  await test("Demo PCM exibe trechos, notas e controles", async () => {
    $("loops").value = "1";
    $("demo-pcm").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.equal($("pcm-panel").hidden, false);
    assert.equal($("pcm-panel").querySelectorAll("tbody tr").length, 2);
    assert.equal($("stat-notes").textContent, "2");
  });
  await test("PCM manual altera nota e pista para percussão", () => {
    const m = $("pcm-panel").querySelector("select");
    m.value = "percussion";
    m.dispatchEvent(new w.Event("change"));
    const key = $("pcm-panel").querySelector("input");
    key.value = "36";
    key.dispatchEvent(new w.Event("change"));
    assert.ok($("track-body").textContent.includes("Percussão inferida"));
  });
  await test("WAV baixável contém RIFF e pode ser ouvido", async () => {
    const row = $("pcm-panel").querySelector("tbody tr"),
      buttons = row.querySelectorAll("button");
    buttons[1].click();
    const b = Buffer.from(await downloads.at(-1).blob.arrayBuffer());
    assert.equal(b.toString("ascii", 0, 4), "RIFF");
    const before = audioStarts;
    buttons[0].click();
    await until(() => audioStarts > before);
    await until(
      () =>
        scopeReads > 0 &&
        !$("pcm-panel").querySelector(".pcm-monitor").hidden &&
        spread($("pcm-panel").querySelector(".pcm-monitor canvas")) > 50,
    );
    assert.ok(
      $("pcm-panel")
        .querySelector(".pcm-monitor")
        .textContent.includes("Trecho 1"),
    );
    $("stop").click();
    assert.equal($("pcm-panel").querySelector(".pcm-monitor").hidden, true);
  });
  await test("Reconversão inválida preserva resultado e ajustes PCM", async () => {
    const before = $("stat-notes").textContent;
    $("loops").value = "0";
    $("reconvert").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.equal($("result").hidden, false);
    assert.equal($("stat-notes").textContent, before);
    assert.ok($("status").textContent.includes("anterior preservado"));
    assert.equal($("pcm-panel").querySelector("select").value, "percussion");
    $("loops").value = "1";
  });
  await test("Reconversão válida mantém mapeamento PCM compatível", async () => {
    $("reconvert").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.equal($("pcm-panel").querySelector("select").value, "percussion");
    assert.equal($("pcm-panel").querySelector("input").value, "36");
  });
  await test("PCM ignorado sai das notas e pode ser restaurado", () => {
    let m = $("pcm-panel").querySelector("select");
    m.value = "ignore";
    m.dispatchEvent(new w.Event("change"));
    assert.equal($("stat-notes").textContent, "1");
    m = $("pcm-panel").querySelector("select");
    m.value = "auto";
    m.dispatchEvent(new w.Event("change"));
    assert.equal($("stat-notes").textContent, "2");
  });
  await test("Falha síncrona ao enviar Worker limpa controles e preserva música", async () => {
    const Original = w.Worker;
    w.Worker = class {
      terminate() {}
      postMessage() {
        throw Error("falha simulada no envio");
      }
    };
    try {
      $("reconvert").click();
      await until(() => $("busybar").hidden);
      assert.equal($("result").hidden, false);
      assert.equal($("browse").disabled, false);
      assert.ok($("status").textContent.includes("anterior preservado"));
    } finally {
      w.Worker = Original;
    }
  });
  await test("Novo HUD cria um osciloscópio e 12 teclas por pista", () => {
    assert.equal(
      $("scope-grid").querySelectorAll("canvas").length,
      Number($("stat-tracks").textContent),
    );
    assert.equal(
      $("scope-grid").querySelectorAll(".scope-key").length,
      12 * Number($("stat-tracks").textContent),
    );
    assert.ok(d.querySelector("header").textContent.includes("MEGA DRIVE"));
  });
  await test("Os scopes leem os analisadores durante a reprodução e as teclas acendem", async () => {
    const before = scopeReads;
    $("play").click();
    await until(() => scopeReads > before);
    assert.ok($("scope-grid").querySelectorAll(".scope-key.on").length > 0);
    assert.ok(spread($("scope-grid").querySelector("canvas")) > 30);
    assert.ok($("scope-grid").querySelector(".level").title.includes("dBFS"));
    $("stop").click();
    assert.equal($("scope-grid").querySelectorAll(".scope-key.on").length, 0);
    assert.equal(spread($("scope-grid").querySelector("canvas")), 0);
  });
  await test("Pausar preserva posição e continuar retoma o transporte", async () => {
    $("play").click();
    await until(() => $("pause").disabled === false);
    await sleep(100);
    $("pause").click();
    assert.ok($("play").textContent.includes("Continuar"));
    const pos = $("seek").value;
    assert.ok(Number(pos) >= 0);
    $("play").click();
    await until(() => $("pause").disabled === false);
    $("stop").click();
    assert.equal($("seek").value, "0");
  });
  await test("Carregar a SF2 enviada mostra os 206 presets", async () => {
    Object.defineProperty($("sf-input"), "files", {
      value: [
        new File(
          [fs.readFileSync("assets/soundfonts/Mega_16-Bit_FM_SF2.sf2")],
          "assets/soundfonts/Mega_16-Bit_FM_SF2.sf2",
        ),
      ],
      configurable: true,
    });
    $("sf-input").dispatchEvent(new w.Event("change"));
    await until(() => $("sf-status").textContent.includes("206 presets"));
    assert.equal($("audio-engine").value, "sf2");
    assert.ok(
      $("track-body").querySelector(".sf-track").options.length === 207,
    );
  });
  await test("Preset SF2 de banco 7 é selecionado e exportado para o MIDI", async () => {
    const sf = $("track-body").querySelector(".sf-track"),
      opt = [...sf.options].find((o) => o.textContent.includes("B7 / P82"));
    assert.ok(opt);
    sf.value = opt.value;
    sf.dispatchEvent(new w.Event("change"));
    $("download").click();
    const b = Buffer.from(await downloads.at(-1).blob.arrayBuffer());
    assert.ok(b.includes(Buffer.from([0xb0, 32, 7])));
    assert.ok(b.includes(Buffer.from([0xc0, 81])));
  });
  await test("Reprodução SF2 usa samples reais e pode ser parada", async () => {
    const old = audioStarts;
    $("play").click();
    await until(() => audioStarts > old);
    assert.equal($("stop").disabled, false);
    await sleep(100);
    $("stop").click();
    assert.equal($("pause").disabled, true);
  });
  await test("SF2 inválida preserva o banco anterior", async () => {
    Object.defineProperty($("sf-input"), "files", {
      value: [new File([new Uint8Array(20)], "invalida.sf2")],
      configurable: true,
    });
    $("sf-input").dispatchEvent(new w.Event("change"));
    await until(() =>
      $("status").textContent.includes("Soundfont anterior preservada"),
    );
    assert.ok($("sf-status").textContent.includes("206 presets"));
  });
  await test("VGM no seletor SF2 preserva o banco e a música existentes", async () => {
    const tracks = $("stat-tracks").textContent;
    inputFiles("sf-input", [{ name: "musica.vgm" }]);
    await sleep(10);
    assert.ok($("status").textContent.includes("somente soundfonts"));
    assert.ok($("sf-status").textContent.includes("206 presets"));
    assert.equal($("stat-tracks").textContent, tracks);
    assert.equal($("audio-engine").value, "sf2");
  });
  await test("Remover SF2 restaura síntese simples e controles GM", () => {
    $("sf-remove").click();
    assert.equal($("audio-engine").value, "synth");
    assert.equal($("track-body").querySelectorAll(".sf-track").length, 0);
  });
  await test("Animações podem ser desativadas", () => {
    $("animations").checked = false;
    $("animations").dispatchEvent(new w.Event("change"));
    assert.ok(d.body.classList.contains("reduce-motion"));
    $("animations").checked = true;
    $("animations").dispatchEvent(new w.Event("change"));
    assert.ok(!d.body.classList.contains("reduce-motion"));
  });
  await test("Demo SegaPCM converte e exibe trechos e scopes", async () => {
    $("demo-extra").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.ok($("pcm-panel").textContent.includes("SegaPCM"));
    assert.ok($("scope-grid").children.length > 0);
  });
  await test("Sem erros JavaScript não tratados durante os fluxos", () =>
    assert.deepEqual(errors, []));
  fs.writeFileSync(
    "tests/results/ui-results.json",
    JSON.stringify(
      {
        environment:
          "jsdom 26.1.0 + Node worker_threads; canvas/audio simulados; sem navegador real",
        total: results.length,
        passed: results.filter((x) => x.status === "PASS").length,
        results,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      total: results.length,
      passed: results.filter((x) => x.status === "PASS").length,
    }),
  );
  dom.window.close();
  if (results.some((x) => x.status === "FAIL")) process.exitCode = 1;
})();
