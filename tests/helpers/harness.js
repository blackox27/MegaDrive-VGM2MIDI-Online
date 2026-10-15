"use strict";
// Local DOM unit tests; no browser is launched and no website is accessed.
const { JSDOM, VirtualConsole } = require("jsdom");
const { Worker: NodeWorker } = require("node:worker_threads");
const fs = require("node:fs"),
  assert = require("node:assert/strict");
function createHarness(options = {}) {
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
    url: options.fileURL
      ? "file:///offline/VGM2MID.html"
      : "https://unit-test.invalid/",
    virtualConsole,
    beforeParse(w) {
      if (options.stored)
        w.localStorage.setItem("vgm2mid.language", options.stored);
      if (options.storageBlocked)
        Object.defineProperty(w, "localStorage", {
          get() {
            throw new w.DOMException("Storage denied", "SecurityError");
          },
        });
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
              "const {parentPort}=require('node:worker_threads');globalThis.self=globalThis;self.postMessage=(data,transfer)=>parentPort.postMessage(data,transfer);" +
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
  return {
    w,
    d,
    $,
    errors,
    downloads,
    blobs,
    results,
    sleep,
    until,
    test,
    spread,
    dropFiles,
    inputFiles,
    chooseFile,
    get audioStarts() {
      return audioStarts;
    },
    get scopeReads() {
      return scopeReads;
    },
    close() {
      dom.window.close();
    },
  };
}
module.exports = { createHarness };
