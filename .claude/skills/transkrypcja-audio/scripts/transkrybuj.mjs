#!/usr/bin/env node
// Lokalna transkrypcja nagrania (Whisper, bez wysyłania pliku na zewnątrz).
//
//   node transkrybuj.mjs nagranie.m4a [--jezyk polish] [--model turbo|small|base|<id z HF>] [--wynik plik.txt]
//
// Zależność (@huggingface/transformers), ffmpeg (gdy nie ma go w systemie) i model pobierają się przy pierwszym
// uruchomieniu do katalogu TRANSKRYPCJA_HOME (domyślnie ./.cache/transkrypcja-audio w bieżącym katalogu).
// Pierwsze uruchomienie wymaga sieci: registry.npmjs.org, github.com + *.githubusercontent.com (ffmpeg),
// huggingface.co + *.hf.co (model).

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// Za proxy (np. w sandboxie) fetch w Node nie czyta HTTPS_PROXY bez tego przełącznika – uruchom się ponownie z nim.
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, ["--no-warnings", ...process.argv.slice(1)],
    { stdio: "inherit", env: { ...process.env, NODE_USE_ENV_PROXY: "1" } });
  process.exit(r.status ?? 1);
}

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const language = opt("--jezyk", "polish");
const modelArg = opt("--model", "turbo");
const outArg = opt("--wynik", null);
const input = args[0];
if (!input || !fs.existsSync(input)) {
  console.error("Użycie: node transkrybuj.mjs nagranie.(m4a|mp3|ogg|opus|wav|mp4|webm) [--jezyk polish] [--model turbo|small|base] [--wynik plik.txt]");
  process.exit(1);
}

const MODELS = {
  turbo: { id: "onnx-community/whisper-large-v3-turbo", dtype: { encoder_model: "fp16", decoder_model_merged: "q8" } },
  small: { id: "onnx-community/whisper-small", dtype: "q8" },
  base: { id: "onnx-community/whisper-base", dtype: "q8" },
};
const model = MODELS[modelArg] || { id: modelArg, dtype: "q8" };

const home = path.resolve(process.env.TRANSKRYPCJA_HOME || ".cache/transkrypcja-audio");
fs.mkdirSync(home, { recursive: true });
if (!fs.existsSync(path.join(home, "package.json"))) fs.writeFileSync(path.join(home, "package.json"), '{"private":true}\n');

// ---------- ffmpeg ----------
function systemFfmpeg() {
  const r = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
  return r.status === 0 ? "ffmpeg" : null;
}
let ffmpeg = process.env.FFMPEG_BIN || systemFfmpeg();

if (!ffmpeg) {
  const exe = path.join(home, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (!fs.existsSync(exe)) {
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-${process.platform}-${process.arch}.gz`;
    console.error(`Brak ffmpeg w systemie – pobieram (jednorazowo) ${url} …`);
    const r = await fetch(url).catch((e) => ({ ok: false, status: e.cause?.code || e.message }));
    if (!r.ok) {
      console.error(`Nie udało się pobrać ffmpeg (${r.status}). Zainstaluj ffmpeg w systemie albo wskaż binarkę zmienną FFMPEG_BIN.`);
      process.exit(1);
    }
    fs.writeFileSync(exe, zlib.gunzipSync(Buffer.from(await r.arrayBuffer())), { mode: 0o755 });
  }
  ffmpeg = exe;
}

// ---------- zależności npm ----------
const need = ["@huggingface/transformers"];
const missing = need.filter((p) => !fs.existsSync(path.join(home, "node_modules", p, "package.json")));
if (missing.length) {
  console.error(`Instaluję (jednorazowo) ${missing.join(", ")} w ${home} …`);
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--prefix", home, "--cache", path.join(home, "npm-cache"), ...missing],
    { stdio: ["ignore", 2, 2], shell: process.platform === "win32" });
}
const require = createRequire(path.join(home, "package.json"));

// ---------- dekodowanie do 16 kHz mono float32 ----------
const pcmPath = path.join(home, `pcm-${process.pid}.f32`);
try {
  execFileSync(ffmpeg, ["-v", "error", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", pcmPath], { stdio: ["ignore", "ignore", 2] });
} catch {
  console.error(`ffmpeg nie odczytał pliku ${input} – sprawdź, czy to poprawne nagranie.`);
  process.exit(1);
}
const buf = fs.readFileSync(pcmPath);
fs.rmSync(pcmPath, { force: true });
const audio = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
const seconds = audio.length / 16000;
if (seconds < 0.5) {
  console.error("Nagranie jest puste lub krótsze niż 0,5 s.");
  process.exit(1);
}
console.error(`Nagranie: ${(seconds / 60).toFixed(1)} min. Model: ${model.id}. Transkrybuję…`);

// ---------- Whisper ----------
const tf = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
tf.env.cacheDir = path.join(home, "modele");
const asr = await tf.pipeline("automatic-speech-recognition", model.id, { dtype: model.dtype });
const t0 = Date.now();
const res = await asr(audio, { language, task: "transcribe", chunk_length_s: 30, stride_length_s: 5, return_timestamps: true });

const stamp = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const lines = (res.chunks || []).map((c) => `[${stamp(c.timestamp?.[0] ?? 0)}] ${c.text.trim()}`).filter((l) => l.length > 8);
const text = lines.length ? lines.join("\n") : res.text.trim();

const outPath = path.resolve(outArg || input.replace(/\.[^.]+$/, "") + ".transkrypcja.txt");
fs.writeFileSync(outPath, text + "\n");
console.error(`Gotowe w ${((Date.now() - t0) / 1000).toFixed(0)} s. Zapisano: ${outPath}`);
console.log(text);
