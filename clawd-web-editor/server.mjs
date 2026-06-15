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
import { replaceStagesInSource, normalizeStage } from "./codec.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 既定は本体の clawd-pet.mjs と隣の designs/。テスト用に環境変数で差し替えられる。
const PET_PATH = process.env.CLAWD_PET_FILE || path.join(HERE, "..", "clawd-pet.mjs");
const DESIGNS_DIR = process.env.CLAWD_DESIGNS_DIR || path.join(HERE, "designs");
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";

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
function applyToSource(stages) {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const next = replaceStagesInSource(source, stages);

  // まず一時ファイルで構文チェック。壊れた状態を本体に書き込まないための関所。
  const tmp = path.join(os.tmpdir(), `clawd-pet-check-${process.pid}-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, next);
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error("生成したコードの構文チェックに失敗した: " + (e.stderr?.toString() || e.message));
  }
  fs.rmSync(tmp, { force: true });

  // バックアップを取ってから上書き。
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${PET_PATH}.bak-${stamp}`;
  fs.copyFileSync(PET_PATH, backup);
  fs.writeFileSync(PET_PATH, next);
  return { backup: path.basename(backup) };
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

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    return sendJson(res, 400, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`clawd-web-editor: http://${HOST}:${PORT}  (Ctrl+C で終了)`);
  console.log(`  保存先: ${DESIGNS_DIR}`);
  console.log(`  適用先: ${PET_PATH}`);
});
