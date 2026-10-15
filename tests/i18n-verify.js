"use strict";
const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { createHarness } = require("./helpers/harness.js");
const h = createHarness(),
  { w, d, $, test, until, sleep, chooseFile, inputFiles, results } = h;
const change = async (lang) => {
  $("language").value = lang;
  $("language").dispatchEvent(new w.Event("change"));
  await sleep(0);
};
(async () => {
  await test("PT-BR é o padrão e o seletor tem ambos os idiomas", () => {
    assert.equal(d.documentElement.lang, "pt-BR");
    assert.deepEqual(
      [...$("language").options].map((x) => x.value),
      ["pt-BR", "en"],
    );
  });
  await test("English traduz controles, campos, áreas e acessibilidade", async () => {
    await change("en");
    assert.ok($("add-file").textContent.includes("Add music"));
    assert.ok($("sf-load").textContent.includes("Load SF2"));
    assert.ok($("browse").textContent.includes("Select music"));
    assert.equal(
      $("file-input").getAttribute("aria-label"),
      "Select VGM, VGZ or GYM music",
    );
    assert.ok($("drop").textContent.includes("Drop music files here"));
    assert.ok(!$("drop").textContent.includes("soundfont"));
    assert.equal(d.documentElement.lang, "en");
    assert.equal(w.localStorage.getItem("vgm2mid.language"), "en");
  });
  await test("Ajuda e análise trocam o documento e mantêm links técnicos", () => {
    const help = $("view-compat").querySelector("[data-doc-lang=en]");
    assert.equal(help.hidden, false);
    assert.equal(
      $("view-compat").querySelector('[data-doc-lang="pt-BR"]').hidden,
      true,
    );
    assert.ok(help.textContent.includes("monophonic"));
    assert.ok(
      $("view-audit")
        .querySelector("[data-doc-lang=en]")
        .textContent.includes("WHATWG"),
    );
  });
  await test("Músicas inválidas e separação SF2 geram mensagens em inglês", async () => {
    inputFiles("sf-input", [{ name: "musica.vgm" }]);
    await sleep(0);
    assert.ok($("status").textContent.includes("Load SF2 only accepts"));
    inputFiles("file-input", [{ name: "fonte.sf2", size: 4 }]);
    await sleep(0);
    assert.ok(
      $("status").textContent.includes("For a soundfont, use Load SF2"),
    );
  });
  await test("Demo em inglês converte em Worker e traduz instrumentos GM", async () => {
    $("demo").click();
    await until(() => $("result").hidden === false);
    await sleep(0);
    assert.ok($("status").textContent.includes("Conversion completed"));
    assert.ok(
      $("track-body")
        .querySelector("select")
        .textContent.includes("Acoustic Grand Piano"),
    );
    assert.ok($("files").textContent.includes("tracks"));
  });
  await test("Troca de idioma preserva nós, instrumentos, volume, transposição e posição", async () => {
    const row = $("track-body").firstElementChild,
      program = row.querySelector("select"),
      volume = row.querySelector("input[type=range]"),
      transpose = row.querySelector("input[type=number]");
    program.value = "40";
    program.dispatchEvent(new w.Event("change"));
    volume.value = "47";
    volume.dispatchEvent(new w.Event("change"));
    transpose.value = "12";
    transpose.dispatchEvent(new w.Event("change"));
    $("seek").value = "300";
    $("download").click();
    const before = Buffer.from(await h.downloads.at(-1).blob.arrayBuffer());
    await change("pt-BR");
    await change("en");
    assert.strictEqual($("track-body").firstElementChild, row);
    assert.equal(program.value, "40");
    assert.equal(volume.value, "47");
    assert.equal(transpose.value, "12");
    assert.equal($("seek").value, "300");
    $("download").click();
    assert.deepEqual(
      Buffer.from(await h.downloads.at(-1).blob.arrayBuffer()),
      before,
    );
  });
  await test("Mudança durante reprodução não para o áudio nem zera o transporte", async () => {
    $("seek").value = "0";
    $("play").click();
    await until(() => $("pause").disabled === false);
    await sleep(100);
    await change("pt-BR");
    assert.equal($("pause").disabled, false);
    assert.ok($("play").textContent.includes("Reiniciar"));
    await change("en");
    assert.equal($("pause").disabled, false);
    assert.ok($("play").textContent.includes("Restart"));
    assert.ok(Number($("seek").value) > 0);
    $("stop").click();
  });
  await test("Erros do parser e nomes de arquivo são preservados/traduzidos separadamente", async () => {
    await chooseFile([
      new File([new Uint8Array([1, 2, 3])], "Piano acústico de Música.vgm"),
    ]);
    await sleep(0);
    assert.ok($("status").textContent.includes("Piano acústico de Música.vgm"));
    assert.ok($("status").textContent.includes("File too short"));
    assert.equal(
      $("files").querySelector(".filename").textContent.includes("Demo"),
      true,
    );
    const filenames = [...$("files").querySelectorAll(".filename")].map(
      (n) => n.textContent,
    );
    assert.ok(filenames.includes("Piano acústico de Música.vgm"));
    await change("pt-BR");
    assert.ok($("status").textContent.includes("Arquivo curto demais"));
    await change("en");
    assert.ok($("status").textContent.includes("File too short"));
  });
  await test("Metadados GD3 com marcação permanecem texto original em ambos os idiomas", async () => {
    await chooseFile([
      new File([fs.readFileSync("tests/fixtures/unicode.vgm")], "unicode.vgm"),
    ]);
    const original = $("song-title").textContent;
    assert.ok(original.includes("Título <img"));
    await change("pt-BR");
    await change("en");
    assert.equal($("song-title").textContent, original);
    assert.equal($("song-title").querySelectorAll("img").length, 0);
  });
  await test("PCM, páginas, opções e notas inferidas são traduzidos", async () => {
    $("demo-pcm").click();
    await until(() => !$("busybar").hidden);
    await until(() => $("busybar").hidden);
    await sleep(0);
    assert.ok($("pcm-panel").textContent.includes("recovered regions"));
    assert.ok($("pcm-panel").textContent.includes("Manual percussion"));
    assert.ok($("track-body").textContent.includes("Inferred notes"));
  });
  await test("Soundfont real mantém nome/presets e seleção quando o idioma muda", async () => {
    inputFiles("sf-input", [
      new File(
        [fs.readFileSync("assets/soundfonts/Mega_16-Bit_FM_SF2.sf2")],
        "Mega_16-Bit_FM_SF2.sf2",
      ),
    ]);
    await until(() => $("sf-status").textContent.includes("206 presets"));
    await sleep(0);
    const sf = $("track-body").querySelector(".sf-track"),
      option = sf.options[3],
      name = option.textContent;
    sf.value = option.value;
    sf.dispatchEvent(new w.Event("change"));
    const selected = sf.value;
    await change("pt-BR");
    await change("en");
    assert.strictEqual($("track-body").querySelector(".sf-track"), sf);
    assert.equal(sf.value, selected);
    assert.equal(sf.options[3].textContent, name);
    assert.equal($("sf-name").textContent, "Mega 16-Bit FM SF2");
    assert.equal($("audio-engine").value, "sf2");
  });
  await test("Diagnóstico baixado usa inglês e identifica a soundfont da prévia", async () => {
    $("diagnostic").click();
    const text = await h.downloads.at(-1).blob.text();
    assert.ok(text.includes("DIAGNOSTICS"));
    assert.ok(text.includes("File:"));
    assert.ok(text.includes("Preview: sf2"));
    assert.ok(text.includes("Preview: Mega 16-Bit FM SF2"));
    assert.ok(!text.includes("Prévia por síntese simples"));
  });
  await test("Erro SF2 inválida traduz mensagem e preserva a fonte", async () => {
    inputFiles("sf-input", [new File([new Uint8Array(20)], "bad.sf2")]);
    await until(() => $("sf-load").disabled === false);
    await sleep(0);
    assert.ok($("status").textContent.includes("Previous soundfont preserved"));
    assert.ok($("sf-status").textContent.includes("206 presets"));
  });
  await test("Ativar/desativar todas altera exportação e preserva escolhas", async () => {
    $("tracks-disable").click();
    await sleep(0);
    const before = h.downloads.length;
    $("download").click();
    await sleep(0);
    assert.equal(h.downloads.length, before);
    assert.ok($("status").textContent.includes("No enabled tracks"));
    $("tracks-enable").click();
    assert.ok(
      [...$("track-body").querySelectorAll("input[type=checkbox]")].every(
        (x) => x.checked,
      ),
    );
    $("download").click();
    assert.equal(h.downloads.length, before + 1);
  });
  await test("Legenda de instrumento segue o motor de prévia", async () => {
    $("audio-engine").value = "synth";
    $("audio-engine").dispatchEvent(new w.Event("change"));
    await sleep(0);
    assert.ok(
      ![...$("scope-grid").querySelectorAll(".scope-foot span")].some(
        (e) => e.dataset.i18nSkip === "true",
      ),
    );
    $("audio-engine").value = "sf2";
    $("audio-engine").dispatchEvent(new w.Event("change"));
    assert.ok(
      [...$("scope-grid").querySelectorAll(".scope-foot span")].some(
        (e) => e.dataset.i18nSkip === "true",
      ),
    );
  });
  await test("Atalho Espaço pausa/retoma e não captura eventos dos campos", async () => {
    $("audio-engine").value = "synth";
    $("audio-engine").dispatchEvent(new w.Event("change"));
    $("seek").value = "0";
    d.body.dispatchEvent(
      new w.KeyboardEvent("keydown", {
        code: "Space",
        bubbles: true,
        cancelable: true,
      }),
    );
    await until(() => $("pause").disabled === false);
    d.body.dispatchEvent(
      new w.KeyboardEvent("keydown", {
        code: "Space",
        bubbles: true,
        cancelable: true,
      }),
    );
    assert.equal($("pause").disabled, true);
    const e = new w.KeyboardEvent("keydown", {
      code: "Space",
      bubbles: true,
      cancelable: true,
    });
    $("bpm").dispatchEvent(e);
    assert.equal(e.defaultPrevented, false);
    assert.equal($("pause").disabled, true);
  });
  await test("Catálogos PT/EN têm todas as chaves e 128 instrumentos traduzidos", () => {
    const pt = JSON.parse(fs.readFileSync("src/i18n/pt-BR.json")),
      en = JSON.parse(fs.readFileSync("src/i18n/en.json"));
    assert.deepEqual(Object.keys(pt), Object.keys(en));
    for (const gm of w.VGMCore.GM) assert.equal(typeof en[gm], "string");
    assert.equal(
      Object.values(en).some((v) => typeof v !== "string" || !v),
      false,
    );
  });
  await test("Preferência English é restaurada ao abrir", () => {
    const other = createHarness({ stored: "en" });
    try {
      assert.equal(other.d.documentElement.lang, "en");
      assert.ok(other.$("add-file").textContent.includes("Add music"));
      assert.deepEqual(other.errors, []);
    } finally {
      other.close();
    }
  });
  await test("Armazenamento bloqueado mantém a troca funcional", () => {
    const other = createHarness({ storageBlocked: true });
    try {
      other.w.I18n.setLanguage("en");
      assert.equal(other.d.documentElement.lang, "en");
      assert.ok(other.$("sf-load").textContent.includes("Load SF2"));
      assert.deepEqual(other.errors, []);
    } finally {
      other.close();
    }
  });
  await test("HTML em origem file não depende de armazenamento ou servidor", () => {
    const other = createHarness({ fileURL: true });
    try {
      other.w.I18n.setLanguage("en");
      assert.ok(other.$("add-file").textContent.includes("Add music"));
      assert.deepEqual(other.errors, []);
    } finally {
      other.close();
    }
  });
  await test("Alternar idiomas repetidamente não duplica controles nem perde nós", async () => {
    const count = d.querySelectorAll("button").length,
      select = $("language"),
      row = $("track-body").firstElementChild;
    for (let i = 0; i < 20; i++) await change(i % 2 ? "en" : "pt-BR");
    assert.equal(d.querySelectorAll("button").length, count);
    assert.strictEqual($("language"), select);
    assert.strictEqual($("track-body").firstElementChild, row);
  });
  await test("As 128 opções GM exibidas usam os nomes ingleses completos", () => {
    const en = JSON.parse(fs.readFileSync("src/i18n/en.json")),
      select = $("track-body").querySelector("select");
    for (let i = 0; i < 128; i++)
      assert.equal(
        select.options[i + 1].textContent,
        String(i + 1).padStart(3, "0") + " · " + en[w.VGMCore.GM[i]],
      );
  });
  await test("Interface estática inglesa não conserva legendas portuguesas por quebras de linha", () => {
    const walker = d.createTreeWalker(d.body, w.NodeFilter.SHOW_TEXT),
      left = [];
    let n;
    while ((n = walker.nextNode())) {
      const text = n.nodeValue.trim();
      if (
        !text ||
        n.parentElement.closest(
          "script,style,[data-doc-lang],[data-i18n-skip=true]",
        ) ||
        text === "Português (BR)"
      )
        continue;
      if (
        /[áàâãéêíóôõúç]|\b(suas|seus|selecione|pistas|Pronto|instrumentos|para|timbres|pelo|notas|Ouvir|Animações|entre)\b/.test(
          text,
        )
      )
        left.push(text);
    }
    assert.deepEqual(left, []);
  });
  await test("Não há erros JavaScript não tratados nos fluxos bilíngues", () =>
    assert.deepEqual(h.errors, []));
  fs.writeFileSync(
    "tests/results/i18n-results.json",
    JSON.stringify(
      {
        environment: "jsdom + simulated Canvas/Web Audio; no real browser",
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
