"use strict";
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { createHarness } = require("./helpers/harness"),
  C = require("../src/core/vgm"),
  SF2 = require("../src/audio/sf2"),
  Scope = require("../src/audio/scopes");
const h = createHarness(),
  { w, d, $, test, until, sleep, inputFiles, chooseFile, results } = h;
async function inject(song, name = "fixture.vgm") {
  const Original = w.Worker;
  w.Worker = class {
    postMessage() {
      setTimeout(() => this.onmessage?.({ data: { song } }), 30);
    }
    terminate() {}
  };
  try {
    await chooseFile([new File([new Uint8Array(64)], name)]);
  } finally {
    w.Worker = Original;
  }
}
(async () => {
  await test("Osciloscópio reutiliza o mesmo array de desenho e o zera no silêncio", () => {
    const values = new Float32Array(512),
      signal = Float32Array.from(
        { length: 4096 },
        (_, i) => 0.002 * Math.sin(i * 0.06),
      );
    const a = Scope.trace(signal, 44100, 440, 0, 512, values);
    assert.strictEqual(a.values, values);
    assert.ok(values.some((x) => x !== 0));
    const b = Scope.trace(null, 44100, 440, a.envelope, 512, values);
    assert.strictEqual(b.values, values);
    assert.equal(
      values.some((x) => x !== 0),
      false,
    );
  });
  await test("Janela do scope valida contagens inválidas sem NaN/divisão por zero", () => {
    for (const count of [0, 1, -1, NaN, Infinity, 100000]) {
      const v = Scope.trace(
        Float32Array.of(-0.1, 0.1, -0.1),
        44100,
        440,
        0,
        count,
      );
      assert.ok(v.values.length >= 2 && v.values.length <= 4096);
      assert.ok([...v.values].every(Number.isFinite));
    }
  });
  await test("Falha em uma camada SF2 posterior limpa vozes já iniciadas", () => {
    let calls = 0,
      stops = 0,
      disconnects = 0;
    const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {} });
    const ctx = {
      createBufferSource() {
        return {
          playbackRate: param(),
          connect() {},
          disconnect() {
            disconnects++;
          },
          start() {},
          stop() {
            stops++;
          },
        };
      },
      createGain() {
        return { gain: param(), connect() {}, disconnect() {} };
      },
      createStereoPanner() {
        return { pan: param(), connect() {}, disconnect() {} };
      },
    };
    const sampler = new SF2.Sampler(ctx, {}),
      r = {
        sample: { root: 60, correction: 0, type: 1, rate: 44100 },
        g: {},
        keyLo: 0,
        keyHi: 127,
        velLo: 0,
        velHi: 127,
      };
    sampler.buffer = () => {
      if (++calls === 2) throw Error("camada inválida");
      return { duration: 1 };
    };
    assert.throws(
      () => sampler.play({ regions: [r, r] }, 60, 100, 0, 0.2, [], {}),
      /camada inválida/,
    );
    assert.ok(stops >= 2);
    assert.ok(disconnects >= 1);
  });
  await test("Orçamento de camadas SF2 respeita as vagas restantes", () => {
    let starts = 0;
    const param = () => ({ setValueAtTime() {}, linearRampToValueAtTime() {} });
    const ctx = {
      createBufferSource() {
        return {
          playbackRate: param(),
          connect() {},
          disconnect() {},
          start() {
            starts++;
          },
          stop() {},
        };
      },
      createGain() {
        return { gain: param(), connect() {}, disconnect() {} };
      },
      createStereoPanner() {
        return { pan: param(), connect() {}, disconnect() {} };
      },
    };
    const sampler = new SF2.Sampler(ctx, {}),
      r = {
        sample: { root: 60, correction: 0, type: 1, rate: 44100 },
        g: {},
        keyLo: 0,
        keyHi: 127,
        velLo: 0,
        velHi: 127,
      };
    sampler.buffer = () => ({ duration: 1 });
    assert.equal(
      sampler.play(
        { regions: Array(16).fill(r) },
        60,
        100,
        0,
        0.2,
        [],
        {},
        0,
        2,
      ).length,
      2,
    );
    assert.equal(starts, 2);
    assert.equal(
      sampler.play({ regions: [r] }, 60, 100, 0, 0.2, [], {}, 0, 0).length,
      0,
    );
    assert.equal(starts, 2);
  });
  await test("Notas sobrepostas mantêm a tecla da nota longa depois do fim da curta", async () => {
    const n = (key, start, end) => ({
      key,
      start,
      end,
      velocity: 100,
      program: 0,
      points: [{ time: start, pitch: key, volume: 100, pan: 64 }],
    });
    const song = {
      format: "VGM",
      version: "1.50",
      samples: 44100,
      duration: 1,
      commands: 4,
      metadata: {},
      clocks: { SN76489: 3579545 },
      warnings: [],
      pcmSegments: [],
      tracks: [
        {
          id: 0,
          name: "Teste",
          program: 0,
          drum: false,
          notes: [n(60, 0, 44100), n(64, 2205, 6615)],
        },
      ],
    };
    await inject(song, "overlap.vgm");
    $("play").click();
    await until(
      () => $("scope-grid").querySelectorAll(".scope-key.on").length === 2,
    );
    await sleep(190);
    const keys = $("scope-grid").querySelectorAll(".scope-key");
    assert.equal(keys[0].classList.contains("on"), true);
    assert.equal(keys[4].classList.contains("on"), false);
    assert.ok(
      $("scope-grid").querySelector(".scope-note").textContent.includes("C4"),
    );
    $("stop").click();
  });
  await test("Navegar pela página de trechos PCM encerra a audição e limpa o monitor", async () => {
    const song = C.parseVGM(C.demoPCMVGM()),
      seg = song.pcmSegments[0];
    song.pcmSegments = Array.from({ length: 21 }, (_, i) => ({
      ...seg,
      id: i,
      start: i * 44100,
      end: i * 44100 + seg.end - seg.start,
      analysis: { ...seg.analysis, notes: [] },
    }));
    song.samples = 21 * 44100;
    song.duration = 21;
    await inject(C.mapPCM(song), "paginas.vgm");
    const buttons = $("pcm-panel")
      .querySelector("tbody tr")
      .querySelectorAll("button");
    buttons[0].click();
    await until(() => $("stop").disabled === false);
    const next = [...$("pcm-panel").querySelectorAll("button")].find((x) =>
      x.textContent.includes("Próximos"),
    );
    next.click();
    assert.equal($("stop").disabled, true);
    assert.equal($("pcm-panel").querySelector(".pcm-monitor").hidden, true);
    assert.equal($("pcm-panel").querySelectorAll("tbody tr").length, 1);
  });
  await test("Carregamento de soundfont bloqueia início de reprodução até terminar", async () => {
    let reject;
    inputFiles("sf-input", [
      {
        name: "aguarde.sf2",
        size: 40,
        arrayBuffer() {
          return new Promise((resolve, r) => (reject = r));
        },
      },
    ]);
    await until(() => $("sf-load").disabled === true);
    assert.equal($("play").disabled, true);
    const starts = h.audioStarts;
    $("play").click();
    assert.equal(h.audioStarts, starts);
    reject(Error("Falha de leitura simulada"));
    await until(() => $("sf-load").disabled === false);
    assert.equal($("play").disabled, false);
  });
  await test("Reutilização do Worker preserva entrada para reconversão e PCM transferido", async () => {
    $("demo-pcm").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    const before = $("stat-notes").textContent,
      sourceBlobs = [...h.blobs.values()].filter(
        (b) => b.type === "application/javascript",
      ).length;
    $("reconvert").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    assert.equal($("stat-notes").textContent, before);
    assert.equal(
      [...h.blobs.values()].filter((b) => b.type === "application/javascript")
        .length,
      sourceBlobs,
    );
    $("pcm-panel")
      .querySelector("tbody tr")
      .querySelectorAll("button")[1]
      .click();
    const out = Buffer.from(await h.downloads.at(-1).blob.arrayBuffer());
    assert.equal(out.toString("ascii", 0, 4), "RIFF");
    assert.ok(out.length > 1000);
  });
  await test("Lote misto converte músicas e mantém visível o aviso dos arquivos rejeitados", async () => {
    await chooseFile([
      new File([C.demoVGM()], "boa.vgm"),
      new File([new Uint8Array(20)], "outra.sf2"),
    ]);
    assert.equal($("result").hidden, false);
    assert.ok($("status").textContent.includes("Arquivos ignorados: 1"));
    assert.ok($("status").textContent.includes("Carregar SF2"));
    assert.ok($("files").textContent.includes("boa.vgm"));
    assert.ok(!$("files").textContent.includes("outra.sf2"));
  });
  await test("Prévia com todas as pistas desativadas avisa e não cria transporte vazio", async () => {
    $("tracks-disable").click();
    $("play").click();
    await sleep(10);
    assert.equal($("pause").disabled, true);
    assert.ok($("status").textContent.includes("pistas ativas"));
    $("tracks-enable").click();
  });
  await test("Array curto do scope e taxa inválida não leem fora da janela", () => {
    for (const rate of [0, NaN, -1, Infinity]) {
      const t = Scope.trace(Float32Array.of(-0.2, 0.2), rate);
      assert.equal(t.span, 1);
      assert.ok([...t.values].every(Number.isFinite));
    }
  });
  await test("Página libera o Blob do Worker ao ser encerrada", () => {
    assert.ok(
      [...h.blobs.values()].some((b) => b.type === "application/javascript"),
    );
    w.dispatchEvent(new w.Event("pagehide"));
    assert.equal(
      [...h.blobs.values()].some((b) => b.type === "application/javascript"),
      false,
    );
    assert.equal($("stop").disabled, true);
  });
  await test("Regressões novas não deixam erros JavaScript pendentes", () =>
    assert.deepEqual(h.errors, []));
  fs.writeFileSync(
    "tests/results/review-results.json",
    JSON.stringify(
      {
        environment:
          "Node and jsdom; simulated Canvas/Web Audio; no real browser",
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
  h.close();
  if (results.some((x) => x.status === "FAIL")) process.exitCode = 1;
})();
