#!/usr/bin/env node
// server.mjs — Clawd ドット絵エディタのローカルサーバー（依存ゼロ）。
//
//   node clawd-web-editor/server.mjs
//
// 起動後 http://127.0.0.1:4173 をブラウザで開く。
//
// 役割は 3 つに分かれている:
//   - 現在のアートを渡す       GET  /api/stages
//   - デザインを「保存」する    POST/GET/DELETE /api/designs
//   - 選んだものを「適用」する  POST /api/apply  （clawd-pet.mjs を書き換え）
// 保存と適用は別の口にしてあるので、いくつも溜めてから良いものだけ反映できる。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  replaceStagesInSource, normalizeStage, replacePoolsInSource, normalizePools,
  replaceConstsInSource, SETTINGS_FIELDS,
} from "./codec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 既定は本体の clawd-pet.mjs と隣の designs/。テスト用に環境変数で差し替えられる。
const PET_PATH = process.env.CLAWD_PET_FILE || path.join(HERE, "..", "clawd-pet.mjs");
const DESIGNS_DIR = process.env.CLAWD_DESIGNS_DIR || path.join(HERE, "designs");
const PORT = Number(process.env.PORT || 4173);
// 既定は loopback（127.0.0.1）で安全側。ただし WSL は localhost 転送が効かず
// Windows のブラウザから届かないので、WSL のときだけ 0.0.0.0 で待つ
// （WSL2 NAT では VM の IP は Windows ホストからしか届かず LAN には出ない）。
// 明示的に絞る/広げるなら HOST 環境変数で上書きする。
const IS_WSL = /microsoft/i.test(os.release());
const HOST = process.env.HOST || (IS_WSL ? "0.0.0.0" : "127.0.0.1");
const URL_HOST = HOST === "0.0.0.0" ? "127.0.0.1" : HOST; // 表示・アクセス用

fs.mkdirSync(DESIGNS_DIR, { recursive: true });

const MIME = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Cache-Control": "no-store", ...headers });
  res.end(body);
}
function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { "Content-Type": "application/json; charset=utf-8" });
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

// id は自前採番のみ。外から来た id はファイル名として使う前に必ず削る。
function safeId(id) {
  return String(id || "").replace(/[^a-zA-Z0-9_-]/g, "");
}

// 受け取った stages を本体に出せる形へ正規化・検証する。
function sanitizeStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0) throw new Error("stages が空");
  return stages.map((s) => {
    if (!Array.isArray(s.frames) || s.frames.length === 0) throw new Error(`${s.name ?? "?"}: frames が無い`);
    if (!Array.isArray(s.blink)) throw new Error(`${s.name ?? "?"}: blink が無い`);
    return normalizeStage(s);
  });
}

function listDesigns() {
  return fs.readdirSync(DESIGNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(DESIGNS_DIR, f), "utf8")); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// clawd-pet.mjs を書き換える。検証に通ってからしか本体に触れない。
// 生成したソースを構文チェック → バックアップ → 上書き。壊れた状態は書き込まない。
function writeSourceChecked(next) {
  const tmp = path.join(os.tmpdir(), `clawd-pet-check-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, next);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error("生成したコードの構文チェックに失敗した: " + (e.stderr?.toString() || e.message));
  }
  fs.rmSync(tmp, { force: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${PET_PATH}.bak-${stamp}`;
  fs.copyFileSync(PET_PATH, backup);
  fs.writeFileSync(PET_PATH, next);
  pruneBackups();
  return { backup: path.basename(backup) };
}

export const BACKUP_KEEP = 5; // 最新いくつのバックアップを残すか
// ファイル名一覧から、消すべき古いバックアップ（新しい順に keep 個を超える分）を返す純粋関数
export function backupsToDelete(filenames, base, keep = BACKUP_KEEP) {
  const baks = filenames.filter((f) => f.startsWith(base)).sort(); // 名前=ISO時刻なので辞書順=時系列順
  return keep > 0 ? baks.slice(0, -keep) : baks;
}
// PET_PATH.bak-* を新しい順に BACKUP_KEEP 個だけ残し、古いものは消す
function pruneBackups() {
  try {
    const dir = path.dirname(PET_PATH);
    const base = path.basename(PET_PATH) + ".bak-";
    for (const f of backupsToDelete(fs.readdirSync(dir), base)) fs.rmSync(path.join(dir, f), { force: true });
  } catch { /* 掃除失敗は無視 */ }
}

function applyToSource(stages) {
  const source = fs.readFileSync(PET_PATH, "utf8");
  return writeSourceChecked(replaceStagesInSource(source, stages));
}

function applySpeech(langs) {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const norm = {};
  for (const lang of ["ja", "en"]) if (langs[lang]) norm[lang] = normalizePools(langs[lang]);
  return writeSourceChecked(replacePoolsInSource(source, norm));
}

// 設定: source 定数 と config.json の二刀流
function petConfigDir() {
  return process.env.CLAWD_PET_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "clawd-pet");
}
function loadPetConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(petConfigDir(), "config.json"), "utf8")); } catch { return {}; }
}

function validateSetting(f, raw) {
  if (f.unit === "Mtok") {
    if (!Array.isArray(raw) || raw.length < 2 || !raw.every((n, i) => Number.isFinite(n) && (i === 0 || n > raw[i - 1]))) {
      throw new Error("進化しきい値は昇順の数値が2つ以上必要");
    }
  } else if (f.unit === "rgb") {
    if (!Array.isArray(raw) || raw.length !== 3 || !raw.every((n) => Number.isFinite(n) && n >= 0 && n <= 255)) {
      throw new Error(`${f.label} は 0〜255 の R,G,B`);
    }
  } else if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error(`${f.label} は正の数`);
  }
}

function applySettings(values) {
  const srcByName = {};
  const cfgPatch = {};
  for (const f of SETTINGS_FIELDS) {
    if (!(f.key in values)) continue;
    const raw = values[f.key];
    validateSetting(f, raw);
    if (f.target === "source") srcByName[f.name] = raw;
    else cfgPatch[f.cfgKey] = raw;
  }
  const result = {};
  if (Object.keys(srcByName).length) {
    const source = fs.readFileSync(PET_PATH, "utf8");
    Object.assign(result, writeSourceChecked(replaceConstsInSource(source, srcByName)));
  }
  if (Object.keys(cfgPatch).length) {
    const dir = petConfigDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "config.json");
    fs.writeFileSync(file, JSON.stringify({ ...loadPetConfig(), ...cfgPatch }, null, 2) + "\n");
    result.config = file;
  }
  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const { pathname } = url;

    // 静的ファイル（index.html / codec.mjs）
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
      return send(res, 200, fs.readFileSync(path.join(HERE, "index.html")), { "Content-Type": MIME[".html"] });
    }
    if (req.method === "GET" && pathname === "/codec.mjs") {
      return send(res, 200, fs.readFileSync(path.join(HERE, "codec.mjs")), { "Content-Type": MIME[".mjs"] });
    }

    // 現在のアート（適用後の再取得に備えてキャッシュを避けて読み直す）
    if (req.method === "GET" && pathname === "/api/stages") {
      const mod = await import(pathToFileURL(PET_PATH).href + "?t=" + Date.now());
      return sendJson(res, 200, { stages: mod.STAGES });
    }

    // 保存済みデザイン一覧
    if (req.method === "GET" && pathname === "/api/designs") {
      return sendJson(res, 200, { designs: listDesigns() });
    }

    // 保存（溜める）
    if (req.method === "POST" && pathname === "/api/designs") {
      const body = await readBody(req);
      const stages = sanitizeStages(body.stages);
      const id = `design-${Date.now()}-${Math.floor(performance.now() % 1e4)}`;
      const design = { id, name: String(body.name || "無題").slice(0, 80), createdAt: Date.now(), stages };
      fs.writeFileSync(path.join(DESIGNS_DIR, `${id}.json`), JSON.stringify(design, null, 2));
      return sendJson(res, 200, { ok: true, design });
    }

    // 削除
    if (req.method === "DELETE" && pathname.startsWith("/api/designs/")) {
      const id = safeId(pathname.slice("/api/designs/".length));
      const file = path.join(DESIGNS_DIR, `${id}.json`);
      if (id && fs.existsSync(file)) fs.rmSync(file);
      return sendJson(res, 200, { ok: true });
    }

    // 適用（選んだものをコードへ反映）
    if (req.method === "POST" && pathname === "/api/apply") {
      const body = await readBody(req);
      const stages = sanitizeStages(body.stages);
      const result = applyToSource(stages);
      return sendJson(res, 200, { ok: true, ...result });
    }

    // 現在のセリフ（言語ごとの pools）
    if (req.method === "GET" && pathname === "/api/speech") {
      const mod = await import(pathToFileURL(PET_PATH).href + "?t=" + Date.now());
      return sendJson(res, 200, { ja: mod.TEXTS.ja.pools, en: mod.TEXTS.en.pools });
    }

    // セリフをコードへ反映
    if (req.method === "POST" && pathname === "/api/speech/apply") {
      const body = await readBody(req);
      const result = applySpeech({ ja: body.ja, en: body.en });
      return sendJson(res, 200, { ok: true, ...result });
    }

    // 現在の設定（source 定数 + config 由来の実効値）
    if (req.method === "GET" && pathname === "/api/settings") {
      const mod = await import(pathToFileURL(PET_PATH).href + "?t=" + Date.now());
      const cfg = mod.resolveConfig(process.env, loadPetConfig());
      const values = {};
      for (const f of SETTINGS_FIELDS) {
        if (f.target === "source") values[f.key] = mod[f.name];
        else if (f.cfgKey === "thresholds") values[f.key] = cfg.thresholds;
        else if (f.cfgKey === "intervalSeconds") values[f.key] = cfg.intervalMs / 1000;
      }
      return sendJson(res, 200, { fields: SETTINGS_FIELDS, values });
    }

    // 設定を反映
    if (req.method === "POST" && pathname === "/api/settings/apply") {
      const body = await readBody(req);
      const result = applySettings(body.values || {});
      return sendJson(res, 200, { ok: true, ...result });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
});

// listen は start() で明示的に。import しただけ（test など）では bind しない。
export function start() {
  // ポート衝突などを生スタックで落とさず、分かる形で終わる
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE") {
      console.error(`clawd-web-editor: ポート ${PORT} は使用中。別インスタンスが起動済みかも → http://${URL_HOST}:${PORT}`);
    } else {
      console.error(`clawd-web-editor: 起動に失敗 — ${e.message}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    console.log(`clawd-web-editor: http://${URL_HOST}:${PORT}  (Ctrl+C で終了)`);
    console.log(`  保存先: ${DESIGNS_DIR}`);
    console.log(`  適用先: ${PET_PATH}`);
  });
  return server;
}

// 直接 `node server.mjs` で起動されたときは即 listen
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
