#!/usr/bin/env node
// Renderer raportu z audytu kulinarnego: raport.json -> PDF (A4 poziomo, slajdy).
// Bez zależności npm. Wymaga Node 18+ i przeglądarki Chromium/Chrome (headless).
//
//   node render.mjs raport.json [wynik.pdf] [--podglad katalog] [--html plik.html]
//
// Kod wyjścia 0 = PDF gotowy; 2 = PDF powstał, ale treść któregoś slajdu się nie mieści
// (lista slajdów na stderr) – skróć tekst albo podziel slajd i wyrenderuj ponownie.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const previewDir = flag("--podglad");
const htmlOut = flag("--html");
const [jsonPath, pdfArg] = args;
if (!jsonPath) {
  console.error("Użycie: node render.mjs raport.json [wynik.pdf] [--podglad katalog] [--html plik.html]");
  process.exit(1);
}

const report = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const baseDir = path.dirname(path.resolve(jsonPath));
const pdfPath = path.resolve(pdfArg || report.output || jsonPath.replace(/\.json$/i, "") + ".pdf");

// ---------- przeglądarka ----------
function findBrowser() {
  if (process.env.CHROME_BIN && fs.existsSync(process.env.CHROME_BIN)) return process.env.CHROME_BIN;
  const home = os.homedir();
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(home, ".cache/ms-playwright"),
    path.join(home, "Library/Caches/ms-playwright"),
    path.join(home, "AppData/Local/ms-playwright"),
  ].filter((p) => p && fs.existsSync(p));
  const rel = [
    "chrome-headless-shell-linux64/chrome-headless-shell",
    "chrome-linux/headless_shell",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
    "chrome-headless-shell-mac-arm64/chrome-headless-shell",
    "chrome-headless-shell-mac-x64/chrome-headless-shell",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
    "chrome-win/chrome.exe",
  ];
  for (const root of roots) {
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith("chromium")).sort().reverse();
    for (const d of dirs) for (const r of rel) {
      const p = path.join(root, d, r);
      if (fs.existsSync(p)) return p;
    }
  }
  const fixed = [
    "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/snap/bin/chromium", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ];
  for (const p of fixed) if (fs.existsSync(p)) return p;
  console.error("Nie znaleziono Chromium/Chrome. Zainstaluj: npx playwright install chromium-headless-shell\n" +
    "albo wskaż binarkę zmienną CHROME_BIN.");
  process.exit(1);
}
const browser = findBrowser();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audyt-raport-"));
function chrome(extra, url) {
  return execFileSync(browser, [
    "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files",
    `--user-data-dir=${path.join(tmp, "profil")}`, ...extra, url,
  ], { maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }).toString();
}

// ---------- zdjęcia ----------
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" };
const imgCache = new Map();
function image(src) {
  if (!src) return "";
  if (/^(data:|https?:)/.test(src)) return src;
  const file = path.resolve(baseDir, src);
  if (imgCache.has(file)) return imgCache.get(file);
  if (!fs.existsSync(file)) throw new Error(`Brak pliku zdjęcia: ${file}`);
  const mime = MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error(`Nieobsługiwany format zdjęcia (${file}). Użyj JPG/PNG/WEBP – HEIC przekonwertuj wcześniej.`);
  let uri = `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
  if (fs.statSync(file).size > 500 * 1024) {
    // Zdjęcia z telefonu mają po kilka MB – zmniejsz do 1600 px, żeby PDF dało się wysłać mailem.
    const helper = path.join(tmp, `img${imgCache.size}.html`);
    fs.writeFileSync(helper, `<!doctype html><body><script>
      const i = new Image();
      i.onload = () => { const s = Math.min(1, 1600 / Math.max(i.naturalWidth, i.naturalHeight));
        const c = document.createElement("canvas"); c.width = Math.round(i.naturalWidth * s); c.height = Math.round(i.naturalHeight * s);
        c.getContext("2d").drawImage(i, 0, 0, c.width, c.height);
        document.body.innerHTML = "<pre id=o>" + c.toDataURL("image/jpeg", 0.85) + "</pre>"; };
      i.onerror = () => { document.body.innerHTML = "<pre id=o>ERR</pre>"; };
      i.src = ${JSON.stringify(uri)};
    </script></body>`);
    const m = chrome(["--virtual-time-budget=15000", "--dump-dom"], pathToFileURL(helper).href).match(/<pre id="o">([^<]+)<\/pre>/);
    if (m && m[1].startsWith("data:image/jpeg") && m[1].length < uri.length) uri = m[1];
  }
  imgCache.set(file, uri);
  return uri;
}

// ---------- HTML ----------
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:]|$)/g, "$1<i>$2</i>").replace(/\n/g, "<br>");
const TONES = { good: "good", ok: "good", warn: "warn", bad: "bad", accent: "accent", dark: "dark" };
const tone = (t) => (TONES[t] ? ` t-${TONES[t]}` : "");

function scoreTone(v) {
  const n = parseFloat(String(v).replace(",", "."));
  if (Number.isNaN(n)) return "";
  return n >= 4 ? " t-good" : n >= 3 ? " t-warn" : " t-bad";
}
function priorityTone(v) {
  const s = String(v).toUpperCase();
  if (/WYSOK|PILN|KRYT/.test(s)) return " t-bad";
  if (/ŚREDNI|SREDNI/.test(s)) return " t-warn";
  if (/NISK/.test(s)) return " t-good";
  return "";
}

function table(b) {
  const cols = b.columns.map((c) => (typeof c === "string" ? { label: c } : c));
  const colgroup = cols.map((c) => `<col${c.width ? ` style="width:${c.width}%"` : ""}>`).join("");
  const head = cols.map((c) => `<th class="a-${c.align || "left"}">${fmt(c.label)}</th>`).join("");
  const rows = b.rows.map((r) => {
    const row = Array.isArray(r) ? { cells: r } : r;
    const tds = row.cells.map((cell, i) => {
      const c = cols[i] || {};
      const o = cell !== null && typeof cell === "object" ? cell : { text: cell };
      let cls = `a-${c.align || "left"}`;
      if (c.kind === "score") cls += " score" + scoreTone(o.text);
      else if (c.kind === "priority") cls += " prio" + priorityTone(o.text);
      else if (c.kind === "bold") cls += " b";
      else if (c.kind === "small") cls += " small";
      if (o.tone) cls += tone(o.tone) + " b";
      if (o.bold) cls += " b";
      return `<td class="${cls}"${o.span ? ` colspan="${o.span}"` : ""}>${fmt(o.text)}</td>`;
    }).join("");
    return `<tr class="${row.style ? "r-" + row.style : ""}">${tds}</tr>`;
  }).join("");
  return `<table class="tbl${b.compact ? " compact" : ""}"><colgroup>${colgroup}</colgroup><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function block(b) {
  const h = b.heading ? `<h3 class="${tone(b.tone || "accent").trim()}">${fmt(b.heading)}</h3>` : "";
  switch (b.type) {
    case "heading":
      return `<h3 class="${tone(b.tone || "accent").trim()}">${fmt(b.text)}</h3>`;
    case "text":
      return `${h}<p class="txt${b.size === "large" ? " large" : ""}">${fmt(b.text)}</p>`;
    case "bullets":
      return `${h}<ul class="bul${tone(b.tone || "accent")}">${b.items.map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>`;
    case "table":
      return h + table(b);
    case "kpis":
      return `${h}<div class="kpis" style="grid-template-columns:repeat(${b.columns || b.items.length},1fr)">${b.items.map((k) =>
        `<div class="kpi"><div class="kl">${fmt(k.label)}</div><div class="kv${tone(k.tone)}">${fmt(k.value)}</div>${k.note ? `<div class="kn">${fmt(k.note)}</div>` : ""}</div>`).join("")}</div>`;
    case "image":
      return `<figure class="img" ${b.height ? `style="flex:0 0 ${b.height}pt"` : ""}><div class="ph" style="background-image:url('${image(b.src)}');background-position:${b.position || "center"}"></div>${b.caption ? `<figcaption>${fmt(b.caption)}</figcaption>` : ""}</figure>`;
    case "images":
      return `<div class="imgs">${b.items.map((i) => block({ type: "image", ...i })).join("")}</div>`;
    case "cards":
      return `<div class="cards" style="grid-template-columns:repeat(${b.columns || 3},1fr)">${b.items.map((c, i) =>
        `<div class="card"><div class="ch"><span class="cn">${String(i + 1).padStart(2, "0")}</span><span class="ct">${fmt(c.title)}</span></div><p>${fmt(c.text)}</p></div>`).join("")}</div>`;
    case "callout":
      return `<div class="callout">${fmt(b.text)}</div>`;
    case "box":
      return `${h}<div class="box"><div class="${b.italic === false ? "" : "it"}">${fmt(b.text)}</div>${b.note ? `<div class="bn">${fmt(b.note)}</div>` : ""}</div>`;
    case "spacer":
      return `<div class="spacer"></div>`;
    default:
      throw new Error(`Nieznany typ bloku: ${b.type}`);
  }
}
const blocks = (list) => (list || []).map(block).join("\n");

function slide(s, n) {
  const brand = esc(report.brand || "");
  if (s.type === "cover" || s.type === "closing") {
    const w = s.imageWidth || (s.type === "cover" ? 47 : 40);
    const left = s.type === "cover"
      ? `<div class="kicker">${fmt(s.kicker)}</div><h1>${fmt(s.title)}</h1>${s.subtitle ? `<div class="sub">${fmt(s.subtitle)}</div>` : ""}
         <ul class="dash">${(s.bullets || []).map((i) => `<li>${fmt(i)}</li>`).join("")}</ul>
         <div class="spacer"></div><div class="meta">${(s.meta || []).map(fmt).join("<br>")}</div>`
      : `<h1 class="closing">${fmt(s.title)}</h1><p class="lead">${fmt(s.text)}</p><div class="spacer"></div>
         ${s.next ? `<div class="nexth">${fmt(s.nextTitle || "Następny krok")}</div><p class="next">${fmt(s.next)}</p>` : ""}
         <div class="spacer"></div>${s.disclaimer ? `<p class="disc">${fmt(s.disclaimer)}</p>` : ""}`;
    return `<section class="slide dark" data-n="${n}"><div class="dl body" style="width:${s.image ? 100 - w : 100}%">
      <div class="brand">${brand}</div><div class="rule"></div>${left}</div>
      ${s.image ? `<div class="dr" style="width:${w}%;background-image:url('${image(s.image)}');background-position:${s.imagePosition || "center"}"></div>` : ""}</section>`;
  }
  const cols = s.columns
    ? `<div class="cols">${s.columns.map((c) => `<div class="col" style="flex:${c.width || 1} 1 0">${blocks(c.blocks)}</div>`).join("")}</div>`
    : "";
  return `<section class="slide" data-n="${n}">
    <header><h2>${fmt(s.title)}</h2><div class="hr"><div class="brand">${brand}</div><div class="sec">${fmt(s.section)}</div></div></header>
    <div class="accentline"></div>
    <div class="body">${s.subtitle ? `<div class="subtitle">${fmt(s.subtitle)}</div>` : ""}
      ${blocks(s.top)}${blocks(s.blocks)}${cols}${blocks(s.bottom)}</div>
    <footer><span>${fmt(report.footer)}</span><span>${n}</span></footer></section>`;
}

const css = `
@page { size: 297mm 210mm; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "DejaVu Sans", Verdana, "Segoe UI", Arial, sans-serif; font-size: 9pt; line-height: 1.45; color: #1f2933;
  --navy: #202a36; --accent: #c2552d; --beige: #f3eee8; --good: #2e7d4f; --warn: #c98a1b; --bad: #b23a3a; --muted: #6b7280; }
.slide { width: 297mm; height: 210mm; position: relative; overflow: hidden; display: flex; flex-direction: column; background: #fff;
  page-break-after: always; break-after: page; }
.slide:last-child { page-break-after: auto; break-after: auto; }
.t-good { color: var(--good); } .t-warn { color: var(--warn); } .t-bad { color: var(--bad); } .t-accent { color: var(--accent); } .t-dark { color: var(--navy); }
b { font-weight: bold; }
header { background: var(--navy); color: #fff; height: 62pt; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 36pt; }
header h2 { font-size: 19pt; font-weight: bold; }
header .hr { text-align: right; } header .brand { font-weight: bold; font-size: 9pt; letter-spacing: .2pt; } header .sec { font-size: 8pt; margin-top: 3pt; }
.accentline { height: 4pt; background: var(--accent); flex: none; }
.body { flex: 1 1 0; min-height: 0; padding: 12pt 36pt 8pt; display: flex; flex-direction: column; gap: 9pt; overflow: hidden; }
.body > *, .col > * { flex: none; }
.subtitle { color: var(--muted); font-size: 10.5pt; margin-bottom: 2pt; }
footer { flex: none; margin: 0 36pt; height: 30pt; border-top: 1pt solid #dcdcdc; display: flex; justify-content: space-between; align-items: center;
  color: var(--muted); font-size: 7.5pt; }
.cols { display: flex; gap: 30pt; flex: 1 1 0 !important; min-height: 0; }
.col { display: flex; flex-direction: column; gap: 9pt; min-width: 0; min-height: 0; }
h3 { font-size: 12pt; font-weight: bold; margin-top: 2pt; }
.txt { font-size: 9pt; } .txt.large { font-size: 10.5pt; line-height: 1.5; }
ul { list-style: none; }
.bul li { position: relative; padding-left: 15pt; margin-bottom: 4pt; color: #1f2933; }
.bul li::before { content: ""; position: absolute; left: 0; top: 3.2pt; width: 6.5pt; height: 6.5pt; background: currentColor; }
.bul.t-accent li::before { background: var(--accent); } .bul.t-good li::before { background: var(--good); }
.bul.t-warn li::before { background: var(--warn); } .bul.t-bad li::before { background: var(--bad); } .bul.t-dark li::before { background: var(--navy); }
.tbl { width: 100%; border-collapse: collapse; font-size: 8.5pt; }
.tbl th { background: var(--navy); color: #fff; font-weight: bold; padding: 4.5pt 6pt; font-size: 8.5pt; }
.tbl td { padding: 4.8pt 6pt; vertical-align: middle; }
.tbl.compact td { padding: 3.2pt 6pt; }
.tbl tbody tr:nth-child(even) { background: var(--beige); }
.a-left { text-align: left; } .a-right { text-align: right; } .a-center { text-align: center; }
.tbl td.b, .tbl td.prio { font-weight: bold; } .tbl td.score { font-weight: bold; font-size: 10.5pt; } .tbl td.small { font-size: 7.8pt; }
.tbl tr.r-strong td { font-weight: bold; } .tbl tr.r-sum td { font-weight: bold; border-top: 1pt solid var(--navy); }
.tbl tbody tr.r-accent { background: var(--accent); } .tbl tr.r-accent td { color: #fff !important; font-weight: bold; }
.tbl tbody tr.r-dark { background: var(--navy); } .tbl tr.r-dark td { color: #fff !important; font-weight: bold; }
.kpis { display: grid; gap: 12pt; }
.kpi { background: var(--beige); border-radius: 6pt; padding: 9pt 12pt 8pt; }
.kl { color: var(--muted); font-size: 8pt; } .kv { font-size: 19pt; font-weight: bold; line-height: 1.25; color: var(--navy); } .kn { color: var(--muted); font-size: 7pt; }
.kv.t-good { color: var(--good); } .kv.t-warn { color: var(--warn); } .kv.t-bad { color: var(--bad); } .kv.t-accent { color: var(--accent); }
figure.img { flex: 1 1 60pt !important; min-height: 60pt; display: flex; flex-direction: column; min-width: 0; }
figure.img .ph { flex: 1 1 0; min-height: 0; border-radius: 6pt; background-size: cover; background-repeat: no-repeat; }
figcaption { color: var(--muted); font-size: 7.5pt; margin-top: 4pt; flex: none; }
.imgs { display: flex; gap: 10pt; flex: 1 1 60pt !important; min-height: 60pt; } .imgs figure.img { flex: 1 1 0 !important; }
.cards { display: grid; gap: 12pt; flex: 1 1 auto !important; min-height: 0; grid-auto-rows: 1fr; }
.card { background: var(--beige); border-top: 3.5pt solid var(--accent); border-radius: 0 0 6pt 6pt; padding: 10pt 12pt; }
.ch { display: flex; align-items: baseline; gap: 6pt; margin-bottom: 10pt; } .cn { color: var(--accent); font-size: 15pt; font-weight: bold; } .ct { font-weight: bold; font-size: 9.5pt; }
.card p { font-size: 8.8pt; line-height: 1.55; }
.callout { background: var(--navy); color: #fff; border-radius: 6pt; padding: 9pt 12pt; font-size: 9pt; }
.box { background: var(--beige); border-radius: 6pt; padding: 10pt 12pt; } .box .it { font-style: italic; } .bn { color: var(--muted); margin-top: 2pt; }
.spacer { flex: 1 1 0 !important; min-height: 0; }
.slide.dark { flex-direction: row; background: var(--navy); color: #fff; }
.dl { padding: 58pt 40pt 44pt; display: flex; flex-direction: column; overflow: hidden; }
.dl > * { flex: none; }
.dr { background-size: cover; background-repeat: no-repeat; }
.dark .brand { font-weight: bold; font-size: 10.5pt; letter-spacing: .3pt; } .rule { width: 60pt; height: 3.5pt; background: var(--accent); margin: 16pt 0 54pt; }
.kicker { font-size: 11pt; color: #d5dae0; } .dark h1 { font-size: 34pt; font-weight: bold; line-height: 1.25; margin-top: 6pt; } .dark h1.closing { font-size: 27pt; margin-top: -14pt; }
.sub { font-size: 19pt; font-weight: bold; } .dash { margin-top: 40pt; font-size: 10pt; color: #d5dae0; } .dash li { margin-bottom: 5.5pt; } .dash li::before { content: "—  "; }
.meta { font-size: 8.5pt; color: #d5dae0; line-height: 1.7; }
.lead { font-size: 11.5pt; line-height: 1.5; margin-top: 18pt; } .nexth { font-weight: bold; font-size: 10.5pt; } .next { color: #d5dae0; font-size: 9.5pt; margin-top: 8pt; }
.disc { color: #9aa3ad; font-size: 6.8pt; line-height: 1.5; }
@media screen { body { background: #777; } .slide { margin: 0 auto; } }
`;

const check = `
window.addEventListener("load", () => {
  const only = new URLSearchParams(location.search).get("only");
  const bad = [];
  document.querySelectorAll(".slide").forEach((s) => {
    const over = [...s.querySelectorAll(".body, .col, .card, .kpi, .box")].some((e) => e.scrollHeight > e.clientHeight + 2 || e.scrollWidth > e.clientWidth + 2);
    const tiny = [...s.querySelectorAll("figure.img .ph")].some((e) => e.clientHeight < 90);
    if (over) bad.push(s.dataset.n + ":treść się nie mieści");
    else if (tiny) bad.push(s.dataset.n + ":zdjęcie ściśnięte poniżej 90pt");
    if (only && s.dataset.n !== only) s.remove();
  });
  document.body.dataset.overflow = bad.join("|");
});`;

const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>${esc(report.title || report.footer || "Raport")}</title><style>${css}</style></head>
<body>${report.slides.map((s, i) => slide(s, i + 1)).join("\n")}<script>${check}</script></body></html>`;

const htmlPath = htmlOut ? path.resolve(htmlOut) : path.join(tmp, "raport.html");
fs.writeFileSync(htmlPath, html);
const url = pathToFileURL(htmlPath).href;

const dom = chrome(["--virtual-time-budget=10000", "--dump-dom"], url);
const overflow = (dom.match(/data-overflow="([^"]*)"/) || [])[1] || "";

fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
chrome(["--no-pdf-header-footer", `--print-to-pdf=${pdfPath}`], url);
console.log(`PDF: ${pdfPath} (${report.slides.length} slajdów, ${(fs.statSync(pdfPath).size / 1024).toFixed(0)} kB)`);

if (previewDir) {
  fs.mkdirSync(previewDir, { recursive: true });
  report.slides.forEach((_, i) => {
    const png = path.resolve(previewDir, `slajd-${String(i + 1).padStart(2, "0")}.png`);
    chrome(["--window-size=1123,794", `--screenshot=${png}`], `${url}?only=${i + 1}`);
  });
  console.log(`Podgląd PNG: ${path.resolve(previewDir)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });

if (overflow) {
  console.error("UWAGA – slajdy do poprawy: " + overflow.split("|").join("; "));
  process.exit(2);
}
