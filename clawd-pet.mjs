#!/usr/bin/env node
// clawd-pet — Claude Code の日次トークン消費で育つターミナルペット
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";

export const MIN_NODE_MAJOR = 20; // package.json の engines と揃える

// `process.version`（"v20.11.0" 等）のメジャー番号が要件を満たすか。満たさなければ
// 案内文（string）を返す。満たせば null。
export function nodeVersionError(version, min = MIN_NODE_MAJOR) {
  const major = parseInt(String(version).replace(/^v/, ""), 10);
  if (Number.isFinite(major) && major < min) {
    return `clawd-pet は Node.js ${min} 以上が必要です（今: ${version}）。新しい Node に切り替えてください。`;
  }
  return null;
}

export const JST_OFFSET_MS = 9 * 3600e3;
export const THRESHOLDS = [0, 2_000_000, 10_000_000, 30_000_000, 80_000_000, 200_000_000];
export const DATA_INTERVAL_MS = 3 * 60e3;
export const RENDER_INTERVAL_MS = 500;
export const SPEECH_INTERVAL_MS = 60e3;
export const PET_DURATION_MS = 2500; // ホイールで撫でられてから喜び状態が続く時間
export const PROJECTS_ROOT = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

// タイムゾーン対応の日付キー。Intl のフォーマッタはタイムゾーンごとにキャッシュする
const dtfCache = new Map();
function dtfFor(tz) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
    dtfCache.set(tz, f);
  }
  return f;
}

// 設定: 環境変数 > 設定ファイル > システム既定
export function resolveConfig(env, file) {
  const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const sysLang = (env.LANG || "").toLowerCase().startsWith("ja") ? "ja" : "en";
  let language = env.CLAWD_PET_LANG || file?.language || sysLang;
  if (language !== "ja" && language !== "en") language = "en";
  const timezone = env.CLAWD_PET_TZ || file?.timezone || sysTz;
  let thresholds = env.CLAWD_PET_THRESHOLDS
    ? env.CLAWD_PET_THRESHOLDS.split(",").map(Number)
    : (file?.thresholds ?? THRESHOLDS);
  const ascending = thresholds.length >= 2 && thresholds.every((n, i) => Number.isFinite(n) && (i === 0 || n > thresholds[i - 1]));
  if (!ascending) thresholds = THRESHOLDS;
  // 間隔は秒指定が主。分指定（intervalMinutes / CLAWD_PET_INTERVAL_MIN）は互換用
  const intervalSec = Number(
    env.CLAWD_PET_INTERVAL_SEC ??
    (env.CLAWD_PET_INTERVAL_MIN != null ? Number(env.CLAWD_PET_INTERVAL_MIN) * 60 : undefined) ??
    file?.intervalSeconds ??
    (file?.intervalMinutes != null ? file.intervalMinutes * 60 : undefined) ??
    DATA_INTERVAL_MS / 1000,
  );
  const intervalMs = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec * 1000 : DATA_INTERVAL_MS;
  return { language, timezone, thresholds, intervalMs };
}

export function dayKey(ms, tz) {
  return dtfFor(tz).format(ms); // en-CA は YYYY-MM-DD
}

function offsetAt(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(ms);
  const o = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  const asUTC = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
  return asUTC - Math.floor(ms / 1000) * 1000;
}

export function midnightMs(ms, tz) {
  const utcMid = Date.parse(dayKey(ms, tz) + "T00:00:00Z");
  // オフセットを候補時刻で測り直して DST 境界を吸収する
  let guess = utcMid - offsetAt(ms, tz);
  guess = utcMid - offsetAt(guess, tz);
  return guess;
}

export function dayKeyJST(ms) {
  return dayKey(ms, "Asia/Tokyo");
}

export function jstMidnightMs(ms) {
  return midnightMs(ms, "Asia/Tokyo");
}

// 料金表（USD per 1M tokens）。Claude Code 本体バイナリ v2.1.173 から抽出した
// statusline の total_cost_usd と同じテーブル
const R_HAIKU35 = { input: 0.8, output: 4, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08 };
const R_HAIKU45 = { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 };
const R_SONNET = { input: 3, output: 15, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3 };
const R_OPUS_OLD = { input: 15, output: 75, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5 };
const R_OPUS = { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 };
const R_FABLE = { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1 };
export const PRICING = {
  "claude-3-5-haiku-20241022": R_HAIKU35,
  "claude-haiku-4-5-20251001": R_HAIKU45,
  "haiku": R_HAIKU45,
  "claude-3-5-sonnet-20241022": R_SONNET,
  "claude-3-7-sonnet-20250219": R_SONNET,
  "claude-sonnet-4-20250514": R_SONNET,
  "claude-sonnet-4-5-20250929": R_SONNET,
  "claude-sonnet-4-6": R_SONNET,
  "sonnet": R_SONNET,
  "claude-opus-4-20250514": R_OPUS_OLD,
  "claude-opus-4-1-20250805": R_OPUS_OLD,
  "claude-opus-4-5-20251101": R_OPUS,
  "claude-opus-4-6": R_OPUS,
  "claude-opus-4-7": R_OPUS,
  "claude-opus-4-8": R_OPUS,
  "opus": R_OPUS,
  "claude-fable-5": R_FABLE,
  "claude-mythos-5": R_FABLE,
  "fable": R_FABLE,
};
const FALLBACK_RATES = R_OPUS; // 本家の既定値も opus 現行レート
const WEB_SEARCH_USD = 0.01;   // 1 リクエストあたり

// 実行時に使う料金表。起動時に LiteLLM から更新される（失敗時は内蔵テーブルのまま）
let activePricing = PRICING;

// LiteLLM の model_prices JSON から anthropic モデルの単価を取り込む（per-token → per-1M に変換）
export function mergeLiteLLMPricing(base, raw) {
  const out = { ...base };
  for (const [key, v] of Object.entries(raw)) {
    if (!v || v.litellm_provider !== "anthropic") continue;
    if (typeof v.input_cost_per_token !== "number" || typeof v.output_cost_per_token !== "number") continue;
    const id = key.replace(/^anthropic\//, "");
    const cacheWrite5m = (v.cache_creation_input_token_cost ?? v.input_cost_per_token * 1.25) * 1e6;
    out[id] = {
      input: v.input_cost_per_token * 1e6,
      output: v.output_cost_per_token * 1e6,
      cacheWrite5m,
      // 1h 単価がなければ Anthropic の慣例比率（5m の 1.6 倍 = 入力の 2 倍）で補完
      cacheWrite1h: v.cache_creation_input_token_cost_above_1hr != null
        ? v.cache_creation_input_token_cost_above_1hr * 1e6
        : cacheWrite5m * 1.6,
      cacheRead: (v.cache_read_input_token_cost ?? v.input_cost_per_token * 0.1) * 1e6,
    };
  }
  return out;
}

const PRICING_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export const PRICING_TTL_MS = 7 * 24 * 3600e3; // 料金表キャッシュの有効期間（1週間）

// キャッシュを読む。{ at: 取得時刻ms, pricing } か null
function readPricingCache(cacheFile) {
  if (!cacheFile) return null;
  try {
    const c = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (!c?.pricing) return null;
    return { at: Date.parse(c.fetchedAt) || 0, pricing: c.pricing };
  } catch { return null; }
}

// 起動時に料金表を更新する。キャッシュが新しければ fetch せず使う。
// 取得不可ならキャッシュ → 内蔵テーブルの順でフォールバック。
export async function refreshPricing({ cacheFile, timeoutMs = 4000, now = Date.now, ttlMs = PRICING_TTL_MS } = {}) {
  const cached = readPricingCache(cacheFile);
  // TTL 内のキャッシュがあれば、毎起動ネットワークに当てない
  if (cached && now() - cached.at < ttlMs) {
    activePricing = { ...PRICING, ...cached.pricing };
    return "cache-fresh";
  }
  if (process.env.CLAWD_PET_NO_FETCH) {
    if (cached) { activePricing = { ...PRICING, ...cached.pricing }; return "cache"; }
    return "disabled";
  }
  try {
    const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    activePricing = mergeLiteLLMPricing(PRICING, raw);
    if (cacheFile) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date(now()).toISOString(), pricing: activePricing }));
      } catch { /* キャッシュ書き込み失敗は無視 */ }
    }
    return "fetched";
  } catch {
    if (cached) { activePricing = { ...PRICING, ...cached.pricing }; return "cache"; }
    return "builtin";
  }
}

function usageCost(u, model) {
  if (model === "<synthetic>") return 0;
  const r = activePricing[model] ?? FALLBACK_RATES;
  // 1h キャッシュ分は単価が異なる（本家と同じ扱い）
  const cw = u.cache_creation_input_tokens || 0;
  const cw1h = Math.min(u.cache_creation?.ephemeral_1h_input_tokens || 0, cw);
  const writeCost = cw1h > 0
    ? (cw1h / 1e6) * r.cacheWrite1h + ((cw - cw1h) / 1e6) * r.cacheWrite5m
    : (cw / 1e6) * r.cacheWrite5m;
  return (u.input_tokens || 0) / 1e6 * r.input +
    (u.output_tokens || 0) / 1e6 * r.output +
    (u.cache_read_input_tokens || 0) / 1e6 * r.cacheRead +
    writeCost +
    (u.server_tool_use?.web_search_requests || 0) * WEB_SEARCH_USD;
}

export function formatCost(usd) {
  return usd > 0.5 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

export function parseUsageLine(line, tz = "Asia/Tokyo") {
  if (!line.includes('"usage"')) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const u = o?.message?.usage;
  if (!u || !o.timestamp) return null;
  const ts = Date.parse(o.timestamp);
  if (Number.isNaN(ts)) return null;
  const tokens =
    (u.input_tokens || 0) + (u.output_tokens || 0) +
    (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  const id = o.message.id || "";
  const req = o.requestId || "";
  return {
    key: id || req ? `${id}:${req}` : null,
    day: dayKey(ts, tz),
    ts,
    tokens,
    cost: usageCost(u, o.message.model),
  };
}

export function stageFor(total, thresholds = THRESHOLDS) {
  let i = thresholds.length - 1;
  while (i > 0 && total < thresholds[i]) i--;
  const floor = thresholds[i];
  const ceil = i + 1 < thresholds.length ? thresholds[i + 1] : null;
  return { index: i, floor, ceil, progress: ceil === null ? 1 : (total - floor) / (ceil - floor) };
}

// ペース = 直近1時間に書かれたトークン量（jsonl のタイムスタンプ基準）。
// メモリ上の観測ではなくファイルの実データから測るので、再起動しても正確。
export const PACE_WINDOW_MS = 60 * 60e3;
export function computeHourPace(entries, now) {
  let sum = 0;
  for (const e of entries) if (now - e.ts <= PACE_WINDOW_MS) sum += e.tokens;
  return sum;
}

export function strWidth(s) {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6) ||
      (c >= 0x1f300 && c <= 0x1faff);
    w += wide ? 2 : 1;
  }
  return w;
}

export function makeBubble(text) {
  const w = strWidth(text);
  return [
    "╭" + "─".repeat(w + 2) + "╮",
    "│ " + text + " │",
    "╰" + "─".repeat(w + 2) + "╯",
  ];
}

export function gauge(progress, width) {
  const p = Math.min(1, Math.max(0, progress));
  const filled = Math.round(p * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export function formatTokensShort(n) {
  if (n >= 1e6) return (n / 1e6) % 1 === 0 ? `${n / 1e6}M` : `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

export function formatCountdown(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function formatPace(pace, lang = "ja") {
  if (pace === null) return TEXTS[lang].measuring;
  if (pace >= 1e6) return (pace / 1e6).toFixed(1) + "M tokens/h";
  if (pace >= 1e3) return Math.round(pace / 1e3) + "K tokens/h";
  return Math.round(pace) + " tokens/h";
}

export function createCollector(root, now = Date.now, tz = "Asia/Tokyo") {
  const files = new Map(); // path -> { offset, remainder }
  const daily = new Map(); // "YYYY-MM-DD" -> { tok, usd }
  const seen = new Set();  // "messageId:requestId"
  let recent = [];         // 今日の { ts, tokens }（ペース算出用、直近1時間に剪定）
  let seenDay = dayKey(now(), tz);

  function rollover(today) {
    seen.clear();
    recent = [];
    for (const k of [...daily.keys()]) if (k !== today) daily.delete(k);
    seenDay = today;
  }

  function ingestLine(line) {
    const p = parseUsageLine(line, tz);
    if (!p) return;
    if (p.key) {
      if (seen.has(p.key)) return;
      seen.add(p.key);
    }
    const d = daily.get(p.day) || { tok: 0, usd: 0 };
    d.tok += p.tokens;
    d.usd += p.cost;
    daily.set(p.day, d);
    if (p.day === seenDay) recent.push({ ts: p.ts, tokens: p.tokens });
  }

  function processFile(fp, st, midnight) {
    let rec = files.get(fp);
    if (!rec) {
      // 初見のファイル。今日書き込みがないものは中身を読まずスキップ位置だけ覚える
      rec = { offset: st.mtimeMs < midnight ? st.size : 0, remainder: "" };
      files.set(fp, rec);
    }
    if (st.size < rec.offset) { rec.offset = 0; rec.remainder = ""; } // 縮小 → 読み直し
    if (st.size === rec.offset) return;
    const fd = fs.openSync(fp, "r");
    try {
      const buf = Buffer.alloc(st.size - rec.offset);
      fs.readSync(fd, buf, 0, buf.length, rec.offset);
      rec.offset = st.size;
      const lines = (rec.remainder + buf.toString("utf8")).split("\n");
      rec.remainder = lines.pop(); // 書き込み途中の最終行は次回へ持ち越し
      for (const line of lines) ingestLine(line);
    } finally {
      fs.closeSync(fd);
    }
  }

  function scan() {
    const t = now();
    const today = dayKey(t, tz);
    if (today !== seenDay) rollover(today);
    const midnight = midnightMs(t, tz);
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(fp);
        } else if (e.isFile() && e.name.endsWith(".jsonl")) {
          let st;
          try { st = fs.statSync(fp); } catch { continue; }
          try { processFile(fp, st, midnight); } catch { /* 次の tick で再試行 */ }
        }
      }
    }
    recent = recent.filter((e) => t - e.ts <= PACE_WINDOW_MS); // 直近1時間ぶんだけ保持
  }

  return {
    scan,
    todayTotal: () => daily.get(dayKey(now(), tz))?.tok || 0,
    todayCost: () => daily.get(dayKey(now(), tz))?.usd || 0,
    recentEntries: () => recent,
  };
}

export const STAGES = [
  {
    name: "clawd",
    bellyRow: 1,
    noBreath: true,
    petOpen: true,
    frames: [
      [
        " ▐▛███▜▌",
        "▝▜█████▛▘",
        "  ▘▘ ▝▝",
      ],
      [
        " ▐▛███▜▌",
        "▝▜█████▛▘",
        "  ▝▘ ▝▘",
      ],
    ],
    blink: [
      " ▐█████▌",
      "▝▜█████▛▘",
      "  ▘▘ ▝▝",
    ],
  },
  {
    name: "ぷちclawd",
    bellyRow: 2,
    frames: [
      [
        "  ▗▟████▙▖",
        " ▐██ ██ ██▌",
        " ▝▜██████▛▘",
        "   ▘▘  ▝▝",
      ],
      [
        "  ▗▟████▙▖",
        " ▐██ ██ ██▌",
        " ▝▜██████▛▘",
        "   ▝▝  ▘▘",
      ],
    ],
    blink: [
      "  ▗▟████▙▖",
      " ▐██▄██▄██▌",
      " ▝▜██████▛▘",
      "   ▘▘  ▝▝",
    ],
  },
  {
    name: "そだちざかり",
    bellyRow: 3,
    frames: [
      [
        "   ▚      ▞",
        "  ▗▄██████▄",
        " ▐███ ██ ███▌",
        " ▐██████████▌",
        " ▝▜████████▛▘",
        "    ▘▘  ▝▝",
      ],
      [
        "   ▞      ▚",
        "  ▗▟██████▙",
        " ▐███ ██ ███▌",
        " ▐██████████▌",
        " ▝▜████████▛▘",
        "    ▘▘  ▝▝",
      ],
    ],
    blink: [
      "   ▚      ▞",
      "  ▗▄██████▄",
      " ▐███▄██▄███▌",
      " ▐██████████▌",
      " ▝▜████████▛▘",
      "    ▘▘  ▝▝",
    ],
  },
  {
    name: "はたらきもの",
    bellyRow: 5,
    frames: [
      [
        "  ▟▙      ▟▙",
        "  ▗▟██████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▙▄▛",
        " ▝▜████████▛▘",
        "   ▘▘    ▝▝",
      ],
      [
        "  ▟▙      ▟▙",
        "  ▗▟██████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▙▄▄",
        " ▝▜████████▛▘",
        "   ▘▘    ▝▝",
      ],
    ],
    blink: [
      "  ▟▙      ▟▙",
      "  ▗▟██████▙▖",
      " ▐███▄██▄███▌",
      " ▐██████████▙▄▛",
      " ▝▜████████▛▘",
      "   ▘▘    ▝▝",
    ],
  },
  {
    name: "でかclawd",
    bellyRow: 5,
    frames: [
      [
        "   ▟▙        ▟▙",
        "  ▗▟██████████▙▖",
        " ▐████ ███ ████▌",
        " ▐██████████████▌ ▗▖",
        " ▐██████████████▙▄▟▘",
        " ▝▜████████████▛▘",
        "   ▐█▌      ▐█▌",
        "    ▘▘      ▝▝",
      ],
      [
        "   ▟▙        ▟▙",
        "  ▗▟██████████▙▖",
        " ▐████ ███ ████▌",
        " ▐██████████████▌",
        " ▐██████████████▙▄▄▖",
        " ▝▜████████████▛▘",
        "   ▐█▌      ▐█▌",
        "    ▘▘      ▝▝",
      ],
    ],
    blink: [
      "   ▟▙        ▟▙",
      "  ▗▟██████████▙▖",
      " ▐████▄███▄████▌",
      " ▐██████████████▌ ▗▖",
      " ▐██████████████▙▄▟▘",
      " ▝▜████████████▛▘",
      "   ▐█▌      ▐█▌",
      "    ▘▘      ▝▝",
    ],
  },
  {
    name: "でんせつのclawd",
    bellyRow: 6,
    crownRows: 2,
    frames: [
      [
        "       █ █ █",
        "       █████",
        "   ▟▙          ▟▙",
        "  ▗▟████████████▙▖",
        " ▐█████ ███ █████▌",
        " █████████████████▌  ▟▘",
        " █████████████████▙▄▟▘",
        " ▜████████████████▌",
        " ▝▜██████████████▛▘",
        "   ▐█▌        ▐█▌",
        "    ▘▘        ▝▝",
      ],
      [
        "       █ █ █",
        "       █████",
        "   ▟▙          ▟▙",
        "  ▗▟████████████▙▖",
        " ▐█████ ███ █████▌",
        " █████████████████▌",
        " █████████████████▙▄▄▖",
        " ▜████████████████▌  ▜▖",
        " ▝▜██████████████▛▘   ▌",
        "   ▐█▌        ▐█▌",
        "    ▘▘        ▝▝",
      ],
    ],
    blink: [
      "       █ █ █",
      "       █████",
      "   ▟▙          ▟▙",
      "  ▗▟████████████▙▖",
      " ▐█████▄███▄█████▌",
      " █████████████████▌  ▟▘",
      " █████████████████▙▄▟▘",
      " ▜████████████████▌",
      " ▝▜██████████████▛▘",
      "   ▐█▌        ▐█▌",
      "    ▘▘        ▝▝",
    ],
  },
];

export const ART_H = 11;       // 最大アート高（Stage 6 の 10 行 + 余白 1）
export const BUBBLE_H = 3;     // 吹き出しの行数
const AXIS_COL = 14;           // ペットと吹き出しの共通中心軸（横幅を詰めるため左寄せ）
const GAUGE_W = 14;

// 寝息: お腹（bellyRow）から上の体を半行だけ沈める。
// 各文字を4象限ブロックとして扱い、「上の行の下半分」と「自分の上半分」を合成して
// 半行下へシフトする。隙間はできず、お腹から下は動かない。
const QUAD_CHARS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"; // index = UL(1)|UR(2)|LL(4)|LR(8)
const QUAD_OF = Object.fromEntries([...QUAD_CHARS].map((c, i) => [c, i]));

export function breathArt(stage) {
  const rows = stage.blink;
  if (stage.noBreath) return rows.slice(); // 小さすぎるステージは呼吸で潰さない
  const out = rows.slice();
  const top = stage.crownRows ?? 0; // 王冠は剛体。呼吸させず固定して金色を保つ
  for (let r = top; r < stage.bellyRow; r++) {
    const above = r > top ? rows[r - 1] : "";
    const cur = rows[r];
    const width = Math.max(above.length, cur.length);
    let line = "";
    for (let c = 0; c < width; c++) {
      const a = QUAD_OF[above[c] ?? " "] ?? 0;
      const q = QUAD_OF[cur[c] ?? " "] ?? 0;
      const ul = a & 4 ? 1 : 0;   // 上のセルの LL → 新しい UL
      const ur = a & 8 ? 2 : 0;   // 上のセルの LR → 新しい UR
      const ll = q & 1 ? 4 : 0;   // 自分の UL → 新しい LL
      const lr = q & 2 ? 8 : 0;   // 自分の UR → 新しい LR
      line += QUAD_CHARS[ul | ur | ll | lr];
    }
    out[r] = line.replace(/\s+$/, "");
  }
  return out;
}

// ステージが取りうる全フレーム（通常2枚・まばたき・呼吸）の最大表示幅。
// 中央寄せをこの幅で固定すると、しっぽ等でフレーム幅が変わってもペットがぶれない。
export function stageArtWidth(stage) {
  let w = 0;
  for (const f of stage.frames) for (const l of f) w = Math.max(w, strWidth(l));
  for (const l of stage.blink) w = Math.max(w, strWidth(l));
  for (const l of breathArt(stage)) w = Math.max(w, strWidth(l));
  return w;
}

const ZZZ_FRAMES = [
  ["", "", "z"],
  ["", "  Z", "z"],
  ["    Z", "  Z", "z"],
];

export function zzzLines(phase) {
  return ZZZ_FRAMES[phase % ZZZ_FRAMES.length];
}

// 撫でられたときに頭の右上で舞うハート（フェーズで増えて昇る）
const HEART_FRAMES = [
  ["", "", "♡"],
  ["", "  ♡", "♥"],
  ["    ♥", "  ♡", "♥"],
];

export function heartLines(phase) {
  return HEART_FRAMES[phase % HEART_FRAMES.length];
}

export function composeScreen(view) {
  const lines = [];
  const art = view.artLines;
  // 頭の右上に出すオーバーレイ（撫でられ→ハート / 睡眠→Zzz）。吹き出しと排他
  const overlay = view.heartPhase != null ? heartLines(view.heartPhase)
    : view.zzzPhase != null ? zzzLines(view.zzzPhase)
    : null;
  const zzz = overlay != null;
  const bubble = overlay ?? makeBubble(view.bubbleText);
  // artWidth が来ればそれで左位置を固定（フレーム間で体がぶれないように）
  const artW = view.artWidth ?? Math.max(...art.map(strWidth));
  const artLeft = Math.max(0, AXIS_COL - Math.floor(artW / 2));
  const pad = ART_H - art.length; // アートは下揃え、吹き出しはその頭のすぐ上
  for (let i = 0; i < BUBBLE_H + ART_H; i++) {
    if (i >= pad && i < pad + BUBBLE_H) {
      const b = bubble[i - pad] ?? "";
      if (b === "") lines.push("");
      else if (zzz) lines.push(" ".repeat(AXIS_COL + 2) + b); // 頭の右上に置く
      else lines.push(" ".repeat(Math.max(0, AXIS_COL - Math.floor(strWidth(b) / 2))) + b);
    } else if (i >= BUBBLE_H + pad) {
      lines.push(" ".repeat(artLeft) + art[i - BUBBLE_H - pad]);
    } else {
      lines.push("");
    }
  }
  lines.push("");
  lines.push(`  Stage ${view.stageIndex + 1} ── ${view.stageName}`);
  lines.push(`  Today : ${formatTokensShort(view.total)} tokens`);
  if (view.ceil === null) {
    lines.push(`  ${formatTokensShort(view.floor ?? THRESHOLDS[view.stageIndex])} [${gauge(1, GAUGE_W)}] MAX`);
  } else {
    lines.push(`  ${formatTokensShort(view.floor ?? THRESHOLDS[view.stageIndex])} [${gauge(view.progress, GAUGE_W)}] ${formatTokensShort(view.ceil)}`);
  }
  lines.push(`  Cost  : ${formatCost(view.cost ?? 0)}`);
  lines.push(`  Pace  : ${formatPace(view.pace, view.lang ?? "ja")}`);
  lines.push(`  Next  : ${formatCountdown(view.nextScanInMs ?? 0)}`);
  return lines;
}

// 表示テキスト（言語別）
export const TEXTS = {
  ja: {
    measuring: "計測中…",
    widen: (c, r, cc, rr) => {
      const p = [];
      if (c - cc > 0) p.push(`横 あと${c - cc}`);
      if (r - rr > 0) p.push(`縦 あと${r - rr}`);
      return `  ウィンドウを ひろげてね（${p.join(" / ")}）`;
    },
    evolved: (name) => `${name}！`,
    firstSpeech: "きょうも がんばろ",
    stageNames: ["clawd", "ぷちclawd", "そだちざかり", "はたらきもの", "でかclawd", "でんせつのclawd"],
    pools: {
      petted: [
        "ふふ、くすぐったい",
        "なでなで ありがとう",
        "きもちいい…",
        "もっと なでて",
      ],
      asleep: [
        "すやすや… zzz",
        "むにゃ…",
        "ゆめでも コード…",
      ],
      legend: [
        "でんせつに なっちゃった",
        "きみ すごすぎ",
        "そだてすぎ かもね…",
      ],
      night: [
        "そろそろ ねたら？",
        "よなかも わるくない",
        "ねむく なってきた…",
      ],
      burning: [
        "トークンが うなってる",
        "すごい いきおいだね！",
        "もえてるねえ",
      ],
      quiet: [
        "きょうは まだ しずかだね",
        "おはよう。なにつくる？",
        "のんびりも いいよね",
      ],
      generic: [
        "きょうも がんばろ",
        "コード かくの たのしいね",
        "そだってるよ",
        "しんかまで あとすこし",
        "claude code は いいぞ",
      ],
    },
  },
  en: {
    measuring: "measuring…",
    widen: (c, r, cc, rr) => {
      const p = [];
      if (c - cc > 0) p.push(`W +${c - cc}`);
      if (r - rr > 0) p.push(`H +${r - rr}`);
      return `  please widen the window (${p.join(" / ")})`;
    },
    evolved: (name) => `${name}!`,
    firstSpeech: "let's code together",
    stageNames: ["clawd", "lil clawd", "growing up", "hard worker", "big clawd", "legendary clawd"],
    pools: {
      petted: ["hehe, that tickles", "thanks for the pets", "that feels nice…", "more pets please"],
      asleep: ["zzz…", "snoring…", "…(dreaming of code)"],
      legend: ["I became a legend", "unstoppable today!", "grow even more…?"],
      night: ["…go to sleep?", "late night coding, huh", "getting sleepy…"],
      burning: ["tokens roaring…!", "what a pace!", "we're on fire"],
      quiet: ["a quiet day so far", "morning! what now?", "slow days are nice too"],
      generic: ["let's code together", "coding is fun, right?", "growing steadily", "almost evolving", "claude code is great"],
    },
  },
};

// 互換: 既定言語（ja）のプール
export const SPEECH_POOLS = TEXTS.ja.pools;

// 優先度: 撫でられ > 睡眠 > 最終形態 > 深夜 > 高ペース > 静かな日 > 汎用
export function pickSpeech(ctx, rand = Math.random, lang = "ja") {
  const { stageIndex, pace, hour, total } = ctx;
  const pools = TEXTS[lang].pools;
  let pool;
  if (ctx.petted) pool = pools.petted;
  else if (ctx.asleep) pool = pools.asleep;
  else if (stageIndex >= 5) pool = pools.legend;
  else if (hour >= 0 && hour < 5) pool = pools.night;
  else if (pace !== null && pace > 20_000_000) pool = pools.burning;
  else if (total < 100_000) pool = pools.quiet;
  else pool = pools.generic;
  return pool[Math.floor(rand() * pool.length)];
}

// 画面が実際に使う最大幅。最小ウィンドウ幅の根拠
export function maxContentWidth() {
  const bubbleRight = (text) => {
    const w = strWidth(text) + 4;
    return Math.max(0, AXIS_COL - Math.floor(w / 2)) + w;
  };
  let max = 0;
  const texts = [];
  for (const lang of Object.keys(TEXTS)) {
    texts.push(...Object.values(TEXTS[lang].pools).flat());
    texts.push(...TEXTS[lang].stageNames.map((n) => TEXTS[lang].evolved(n)));
  }
  for (const t of texts) max = Math.max(max, bubbleRight(t));
  for (const st of STAGES) {
    const artW = Math.max(...st.frames.flat().concat(st.blink ?? []).map(strWidth));
    max = Math.max(max, Math.max(0, AXIS_COL - Math.floor(artW / 2)) + artW);
  }
  // ステータス行の最悪ケース（レンジ表記が最長の Stage 5、桁の多い数値）
  const s = stageFor(THRESHOLDS[4]);
  const sample = composeScreen({
    artLines: STAGES[4].frames[0], bubbleText: "", stageIndex: 4, stageName: STAGES[4].name,
    total: 999_999_999, progress: 1, ceil: s.ceil, pace: 99_999_999, cost: 9999.99, nextScanInMs: 599_000,
  });
  for (const l of sample) max = Math.max(max, strWidth(l));
  return max;
}

export const MIN_COLS = maxContentWidth();

// 必要な高さ。最終形態（最大アート）を基準に固定する。
// 一度この高さに窓を合わせれば、以後どのステージでもメッセージは出ない。
export function maxContentHeight() {
  let max = 0;
  for (const st of STAGES) {
    const s = stageFor(THRESHOLDS[STAGES.indexOf(st)]);
    const lines = composeScreen({
      artLines: st.blink, bubbleText: "", stageIndex: s.index, stageName: st.name,
      total: 0, progress: s.progress, ceil: s.ceil, pace: null, cost: 0, nextScanInMs: 0,
    });
    const leading = Math.max(0, lines.findIndex((l) => l !== ""));
    max = Math.max(max, lines.length - leading);
  }
  return max;
}

export const MIN_ROWS = maxContentHeight() + 1; // +1 はカーソル行ぶん

// 高さが足りないときは上部の空行（成長の余白）を削って収める。それでも入らなければ null
export function fitLines(lines, rows) {
  const out = [...lines];
  while (out.length + 1 > rows && out.length > 0 && out[0] === "") out.shift();
  return out.length + 1 <= rows ? out : null;
}

// 対話式プレビューの状態（↑↓で切り替え）
export const PREVIEW_STATES = ["idle", "sleep", "pet", "ripple"];

// プレビューの1フレーム分のアニメ状態を決める純粋関数。
// ステージ・状態・時刻から、表示するアートと各オーバーレイのフェーズを返す
export function previewSpec(stageIndex, state, now) {
  const stage = STAGES[stageIndex];
  const floor = THRESHOLDS[stageIndex];
  const ceil = stageIndex + 1 < THRESHOLDS.length ? THRESHOLDS[stageIndex + 1] : null;
  // そのステージらしさが出る代表トークン量（ゲージが途中まで埋まる値）
  const total = ceil === null ? Math.round(floor * 1.3) : Math.round(floor + (ceil - floor) * 0.4);
  const idleFrame = Math.floor(now / 700) % 2;
  const blinkOn = now % 4000 < 200;
  let art = stage.frames[idleFrame];
  let zzzPhase = null, heartPhase = null, rippleActive = false, sleepBody = false;
  if (state === "sleep") {
    art = Math.floor(now / 2000) % 2 === 1 ? breathArt(stage) : stage.blink;
    zzzPhase = Math.floor(now / 900) % 3;
    sleepBody = true;
  } else if (state === "pet") {
    art = stage.petOpen ? stage.frames[0] : stage.blink;
    heartPhase = Math.floor(now / 300) % 3;
  } else if (state === "ripple") {
    art = stage.frames[idleFrame];
    rippleActive = true;
  } else {
    art = blinkOn && stage.blink ? stage.blink : stage.frames[idleFrame];
  }
  const s = stageFor(total);
  return { art, zzzPhase, heartPhase, rippleActive, sleepBody, total, progress: s.progress, ceil: s.ceil, floor: s.floor };
}

// 進化エフェクト: 本家 ultracode 選択時の波紋（UltraRippleText）の再現
// 既定のグラデーション端点 rgb(62,22,118)→rgb(140,80,240)、波長 20 セル、速度 0.03 セル/ms は本家バイナリの定数
export const RIPPLE_COLOR_FROM = [62, 22, 118];  // 波の内側の色
export const RIPPLE_COLOR_TO = [140, 80, 240];   // 波の外側の色
export const RIPPLE_RAMP = Array.from({ length: 8 }, (_, i) => {
  const t = i / 7;
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return [lerp(RIPPLE_COLOR_FROM[0], RIPPLE_COLOR_TO[0]), lerp(RIPPLE_COLOR_FROM[1], RIPPLE_COLOR_TO[1]), lerp(RIPPLE_COLOR_FROM[2], RIPPLE_COLOR_TO[2])];
});
export const RIPPLE_WAVELENGTH = 20;
export const RIPPLE_SPEED = 0.03;     // セル/ms
export const RIPPLE_DURATION_MS = 4000;
const RIPPLE_W = 56;                  // 波紋を塗る既定幅

// span は「発生していた輪の幅」。発生が止まると内側 (dist < travel - span) は
// 輪が通り過ぎて空き、外側の輪だけが travel に従って広がっていく。
// span 既定 = travel（＝中心まで埋まる従来挙動）。
// 波紋の総寿命(ms): 発生時間 + 最後の輪が画面端(maxDist セル)へ抜けるまでの時間。
export function rippleLifetimeMs(maxDist) {
  return RIPPLE_DURATION_MS + maxDist / RIPPLE_SPEED;
}

export function rippleLevel(dist, travel, span = travel) {
  if (dist > travel) return null;          // まだ波が届いていない
  if (dist < travel - span) return null;   // 発生停止後、輪が通り過ぎた内側
  const q = (((dist - travel) % RIPPLE_WAVELENGTH) + RIPPLE_WAVELENGTH) % RIPPLE_WAVELENGTH;
  const k = (1 + Math.cos((2 * Math.PI * q) / RIPPLE_WAVELENGTH)) / 2;
  return Math.min(RIPPLE_RAMP.length - 1, Math.round(k * (RIPPLE_RAMP.length - 1)));
}

// 各行を波紋の背景色つき ANSI 文字列にする。覆われていない部分は baseColors[r] で描く
export function applyRipple(lines, origin, travel, baseColors, width = RIPPLE_W, span = travel) {
  const out = [];
  for (let r = 0; r < lines.length; r++) {
    let line = lines[r];
    const padW = width - strWidth(line);
    if (padW > 0) line += " ".repeat(padW); // 余白にも波を見せる
    const runs = [];
    let col = 0;
    for (const ch of line) {
      const w = strWidth(ch);
      const dx = col + w / 2 - origin.col;
      const dy = (r - origin.row) * 2; // 行方向は 2 倍（本家と同じアスペクト補正）
      const level = rippleLevel(Math.sqrt(dx * dx + dy * dy), travel, span);
      const last = runs[runs.length - 1];
      if (last && last.level === level) last.text += ch;
      else runs.push({ level, text: ch });
      col += w;
    }
    out.push(runs.map((run) => {
      if (run.level === null) return baseColors[r] ? baseColors[r] + run.text + RESET : run.text;
      const [R, G, B] = RIPPLE_RAMP[run.level];
      return `\x1b[48;2;${R};${G};${B}m\x1b[38;2;255;255;255m${run.text}${RESET}`;
    }).join(""));
  }
  return out;
}

export const RESET = "\x1b[0m";
export const SLEEP_AFTER_MS = 15 * 60e3; // この時間トークンが動かなければ寝る

// SGR マウス入力からホイールイベントだけ取り出す（64=上, 65=下）。
// 末尾の未完了シーケンスは rest に残して次のチャンクへ繰り越す
export function parseMouseEvents(buf) {
  const events = [];
  const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
  let consumedTo = 0, m;
  while ((m = re.exec(buf)) !== null) {
    const b = Number(m[1]);
    if (b === 64) events.push("up");
    else if (b === 65) events.push("down");
    consumedTo = re.lastIndex;
  }
  let rest = buf.slice(consumedTo);
  const esc = rest.indexOf("\x1b");
  rest = esc >= 0 ? rest.slice(esc) : ""; // 途中のエスケープ断片だけ保持
  return { events, rest };
}

const PALETTE_TRUE = {
  body: "\x1b[38;2;217;119;87m",      // 本家ブランドカラー #D97757
  sleepBody: "\x1b[38;2;140;85;66m",  // 寝ているときは暗めのオレンジ
  crown: "\x1b[38;2;255;200;60m",     // 王冠の金
};
const PALETTE_256 = {
  body: "\x1b[38;5;208m",
  sleepBody: "\x1b[38;5;130m",
  crown: "\x1b[38;5;220m",
};

function configDir() {
  return process.env.CLAWD_PET_CONFIG_DIR ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "clawd-pet");
}

function loadConfigFile() {
  try { return JSON.parse(fs.readFileSync(path.join(configDir(), "config.json"), "utf8")); } catch { return null; }
}

// 初回起動: 言語とタイムゾーンを聞いて設定ファイルに保存する
// ↑↓ で選んで Enter で決定するメニュー。選んだ index を返す。
// 非 TTY なら既定 index をそのまま返す。Ctrl+C は既定で確定。
function selectMenu(title, options, def = 0) {
  const stdin = process.stdin, out = process.stdout;
  if (!stdin.isTTY || !stdin.setRawMode) return Promise.resolve(def);
  return new Promise((resolve) => {
    let cur = def;
    const draw = (first) => {
      if (!first) out.write(`\x1b[${options.length}A`); // 行数ぶん上へ戻って描き直す
      for (let i = 0; i < options.length; i++) {
        const on = i === cur;
        out.write(`\r\x1b[K  ${on ? "▸ \x1b[36m" : "  "}${options[i]}\x1b[0m\n`);
      }
    };
    out.write(title + "\n");
    draw(true);
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    const done = (val) => { stdin.off("data", onData); stdin.setRawMode(false); stdin.pause(); resolve(val); };
    const onData = (d) => {
      if (d.includes("\x03")) return done(def); // Ctrl+C
      // 1チャンクに複数キーが来ても取りこぼさない
      for (const k of d.match(/\x1b\[[AB]|\x1bO[AB]|[\r\nkj]/g) || []) {
        if (k === "\x1b[A" || k === "\x1bOA" || k === "k") cur = (cur - 1 + options.length) % options.length;
        else if (k === "\x1b[B" || k === "\x1bOB" || k === "j") cur = (cur + 1) % options.length;
        else return done(cur); // \r or \n
      }
      draw();
    };
    stdin.on("data", onData);
  });
}

// タイムゾーン候補（先頭＝既定の Asia/Tokyo）。最後は手入力。
const TZ_CHOICES = [
  "Asia/Tokyo", "UTC", "America/New_York", "America/Los_Angeles",
  "Europe/London", "Europe/Paris", "Asia/Shanghai", "Australia/Sydney",
];

async function firstRunWizard() {
  console.log("clawd-pet をはじめるよ / Let's set up clawd-pet");
  console.log("（↑↓ で選んで Enter で決定 / use ↑↓ then Enter）\n");

  const li = await selectMenu("言語 / language", ["日本語", "English"], 0);
  const language = li === 1 ? "en" : "ja";

  const tzLabel = language === "ja" ? "タイムゾーン" : "Timezone";
  const other = language === "ja" ? "その他（手入力）" : "Other (type it)";
  const ti = await selectMenu(`\n${tzLabel}`, [...TZ_CHOICES, other], 0);
  let timezone = TZ_CHOICES[ti];
  if (timezone === undefined) { // 「その他」を選んだ → IANA 名を手入力
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      const q = language === "ja" ? "IANA 名（例: Asia/Seoul）: " : "IANA name (e.g. Asia/Seoul): ";
      timezone = (await rl.question(q).catch(() => "")).trim() || "Asia/Tokyo";
    } finally { rl.close(); }
  }
  try { dayKey(Date.now(), timezone); } catch {
    console.log(language === "ja" ? `  「${timezone}」は不明。Asia/Tokyo を使うわ` : `  unknown "${timezone}" — using Asia/Tokyo`);
    timezone = "Asia/Tokyo";
  }

  const cfg = { language, timezone, thresholds: THRESHOLDS, intervalSeconds: DATA_INTERVAL_MS / 1000 };
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(language === "ja"
    ? `\n  ${language} / ${timezone} で保存したよ: ${file}\n  あとで ${path.basename(file)} を直接編集してもOK。\n`
    : `\n  saved (${language} / ${timezone}): ${file}\n  you can edit ${path.basename(file)} later.\n`);
  return cfg;
}

function detectPalette() {
  if (process.env.COLORTERM && /truecolor|24bit/i.test(process.env.COLORTERM)) return PALETTE_TRUE;
  return PALETTE_256;
}

// 吹き出し+アート枠の各行の色。王冠行だけ crown、他は body
export function topLineColors(artLen, crownRows, palette) {
  const artTop = BUBBLE_H + (ART_H - artLen);
  const colors = [];
  for (let i = 0; i < BUBBLE_H + ART_H; i++) {
    colors.push(crownRows > 0 && i >= artTop && i < artTop + crownRows ? palette.crown : palette.body);
  }
  return colors;
}

const hourDtfCache = new Map();
function hourIn(ms, tz) {
  let f = hourDtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit" });
    hourDtfCache.set(tz, f);
  }
  return Number(f.format(ms)) % 24;
}

function once(cfg = resolveConfig(process.env, loadConfigFile())) {
  const c = createCollector(PROJECTS_ROOT, Date.now, cfg.timezone);
  c.scan();
  const total = c.todayTotal();
  const s = stageFor(total, cfg.thresholds);
  console.log(`today=${total} cost=$${c.todayCost().toFixed(2)} stage=${s.index + 1} progress=${(s.progress * 100).toFixed(1)}%`);
}

// 合成済みブロックを端末の縦横中央に色付き描画する（runLoop と --preview で共用）。
// footer があれば最下部に固定。ripple を渡すと波紋エフェクトで描く
function paintCentered(out, lines, art, opts) {
  const { cols, rows, palette, crownRows = 0, ripple = null, body, footer = [], artWidth = null } = opts;
  // 詰めるのは成長余白（アートが低いぶんの上部空行）だけ。吹き出し領域の3行は保つ
  const maxTrim = ART_H - art.length;
  let lead = 0;
  while (lead < maxTrim && lines[lead] === "") lead++;
  const fitted = lines.slice(lead);
  const trimmed = lead;

  let L = Infinity, R = 0;
  for (const l of fitted) {
    if (l === "") continue;
    L = Math.min(L, l.length - l.trimStart().length);
    R = Math.max(R, strWidth(l));
  }
  if (!Number.isFinite(L)) L = 0;
  // アートの右端をステージ共通の最大幅で固定し、フレーム差で leftPad がぶれないようにする
  if (artWidth != null) {
    R = Math.max(R, Math.max(0, AXIS_COL - Math.floor(artWidth / 2)) + artWidth);
  }
  const leftPad = Math.max(0, Math.floor((cols - L - R) / 2));
  const topPad = Math.max(0, Math.floor((rows - 1 - footer.length - fitted.length) / 2));

  if (ripple) {
    // 波紋は画面いっぱいに広げる。上下左右のマージン（空きセル）も巻き込む
    const top = topLineColors(art.length, crownRows, palette);
    const footerStart = (rows - 1) - footer.length;
    const waveLines = [];
    const baseColors = [];
    for (let i = 0; i < topPad; i++) { waveLines.push(""); baseColors.push(""); }
    for (let i = 0; i < fitted.length; i++) {
      waveLines.push(" ".repeat(leftPad) + fitted[i]);
      baseColors.push(i + trimmed < top.length ? top[i + trimmed] : "");
    }
    while (waveLines.length < footerStart) { waveLines.push(""); baseColors.push(""); }
    const origin = {
      col: leftPad + AXIS_COL,
      row: topPad + BUBBLE_H + (ART_H - art.length) + Math.floor(art.length / 2) - trimmed,
    };
    const travel = (ripple.now - ripple.start) * RIPPLE_SPEED;
    // 発生は RIPPLE_DURATION_MS で止め、以降は最後の輪が外へ抜けるに任せる
    const span = Math.min(travel, RIPPLE_DURATION_MS * RIPPLE_SPEED);
    const rippled = applyRipple(waveLines, origin, travel, baseColors, cols, span);
    let buf = "\x1b[H";
    for (const line of rippled) buf += line + "\x1b[K\n";
    for (const f of footer) buf += f + "\x1b[K\n";
    buf += "\x1b[J";
    out.write(buf);
    return;
  }

  const top = topLineColors(art.length, crownRows, { ...palette, body });
  const rendered = fitted.map((line, i) => (i + trimmed < top.length ? top[i + trimmed] + line + RESET : line));
  const pad = " ".repeat(leftPad);
  let buf = "\x1b[H";
  for (let i = 0; i < topPad; i++) buf += "\x1b[K\n";
  for (const line of rendered) buf += pad + line + "\x1b[K\n";
  if (footer.length) {
    const blanks = Math.max(0, rows - 1 - topPad - rendered.length - footer.length);
    for (let i = 0; i < blanks; i++) buf += "\x1b[K\n";
    for (const f of footer) buf += f + "\x1b[K\n";
  }
  buf += "\x1b[J";
  out.write(buf);
}

function runLoop(opts = {}) {
  const cfg = opts.cfg ?? resolveConfig(process.env, loadConfigFile());
  const T = TEXTS[cfg.language];
  const palette = detectPalette();
  const collector = createCollector(PROJECTS_ROOT, Date.now, cfg.timezone);
  let lastDay = dayKey(Date.now(), cfg.timezone);
  let speech = T.firstSpeech;
  let lastSpeechAt = 0;
  let frameIdx = 0;
  let frameToggleAt = 0;
  let blinkUntil = 0;
  let nextBlinkAt = Date.now() + 3000 + Math.random() * 5000;
  let lastStageIndex = null;          // 進化検出用
  let rippleStart = opts.demoRipple ? Date.now() : null;
  let rippleTimer = null;
  let lastTotalSeen = -1;             // 睡眠判定: 最後に消費が動いた時刻を追う
  let lastGrowthAt = Date.now();
  let nextScanAt = Date.now();        // カウントダウン表示用
  let lastPetAt = 0;                  // 撫でられ判定: 最後にホイールが回された時刻

  const out = process.stdout;
  const stdin = process.stdin;
  const useMouse = stdin.isTTY && typeof stdin.setRawMode === "function";
  // 代替スクリーン + カーソル非表示 (+ マウストラッキング)
  out.write("\x1b[?1049h\x1b[?25l" + (useMouse ? "\x1b[?1000h\x1b[?1006h" : ""));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    out.write("\x1b[?25h" + (useMouse ? "\x1b[?1000l\x1b[?1006l" : "") + "\x1b[?1049l");
    if (useMouse) { try { stdin.setRawMode(false); } catch { /* noop */ } }
  };
  const quit = () => { cleanup(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", cleanup);

  // ホイールを回す = 撫でる。raw mode では Ctrl+C / q を自前で終了に変換する
  if (useMouse) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let pending = "";
    stdin.on("data", (chunk) => {
      if (chunk.includes("\x03") || chunk.includes("q")) return quit();
      const { events, rest } = parseMouseEvents(pending + chunk);
      pending = rest;
      if (events.length > 0) {
        const now = Date.now();
        lastPetAt = now;
        speech = pickSpeech({ stageIndex: stageFor(collector.todayTotal(), cfg.thresholds).index, petted: true }, Math.random, cfg.language);
        lastSpeechAt = now; // 撫でた後もしばらく嬉しいセリフが残る
        renderTick(); // 即座に反応を返す
      }
    });
  }

  const dataTick = () => {
    const now = Date.now();
    const today = dayKey(now, cfg.timezone);
    if (today !== lastDay) lastDay = today;
    collector.scan();
    const tot = collector.todayTotal();
    if (tot > lastTotalSeen) { lastGrowthAt = now; lastTotalSeen = tot; }
  };

  const renderTick = () => {
    const now = Date.now();
    const total = collector.todayTotal();
    const pace = computeHourPace(collector.recentEntries(), now);
    const s = stageFor(total, cfg.thresholds);
    const stage = STAGES[Math.min(s.index, STAGES.length - 1)];
    const stageName = T.stageNames[Math.min(s.index, T.stageNames.length - 1)];

    // 進化検出 → 波紋エフェクト発動（起動直後の初期化では発動しない）
    if (lastStageIndex === null) {
      lastStageIndex = s.index;
    } else if (s.index > lastStageIndex) {
      rippleStart = now;
      speech = T.evolved(stageName);
      lastSpeechAt = now;
      lastStageIndex = s.index;
    } else {
      lastStageIndex = s.index; // 日付リセットで戻ったときも追従
    }
    const cols0 = out.columns || 80, rows0 = out.rows || 24;
    const rippleLife = rippleLifetimeMs(Math.sqrt(cols0 * cols0 + (rows0 * 2) * (rows0 * 2)));
    const rippleActive = rippleStart !== null && now - rippleStart < rippleLife;
    const petted = !rippleActive && (opts.demoPet || now - lastPetAt < PET_DURATION_MS);
    const asleep = !rippleActive && !petted && (opts.demoSleep || now - lastGrowthAt >= SLEEP_AFTER_MS);

    if (now >= frameToggleAt) { frameIdx++; frameToggleAt = now + 1000; }
    if (now >= nextBlinkAt) { blinkUntil = now + 400; nextBlinkAt = now + 4000 + Math.random() * 6000; }
    // 寝姿: 目を閉じて、2秒周期でお腹が縮む（呼吸）。撫でられ中も目を細めて嬉しそうに
    const exhale = asleep && Math.floor(now / 2000) % 2 === 1;
    let art;
    if (asleep) art = exhale ? breathArt(stage) : stage.blink;
    else if (petted) art = stage.petOpen ? stage.frames[0] : stage.blink;
    else art = stage.blink && now < blinkUntil ? stage.blink : stage.frames[frameIdx % stage.frames.length];

    if (now - lastSpeechAt >= SPEECH_INTERVAL_MS) {
      speech = pickSpeech({ stageIndex: s.index, pace, hour: hourIn(now, cfg.timezone), total, asleep }, Math.random, cfg.language);
      lastSpeechAt = now;
    }
    if (asleep && !T.pools.asleep.includes(speech)) {
      // 眠った瞬間にセリフも寝かせる
      speech = pickSpeech({ stageIndex: s.index, pace: null, hour: hourIn(now, cfg.timezone), total, asleep: true }, Math.random, cfg.language);
      lastSpeechAt = now;
    }

    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const artWidth = stageArtWidth(stage);
    const lines = composeScreen({
      artLines: art, bubbleText: speech, stageIndex: s.index, stageName, artWidth,
      total, progress: s.progress, ceil: s.ceil, floor: s.floor, pace,
      cost: collector.todayCost(), nextScanInMs: nextScanAt - now, lang: cfg.language,
      zzzPhase: asleep ? Math.floor(now / 1000) % 3 : null,
      heartPhase: petted ? Math.floor(now / 300) % 3 : null,
    });
    // 必要サイズは最終形態を基準に固定。一度合わせれば成長してもメッセージは出ない
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      out.write("\x1b[H\x1b[2J" + T.widen(MIN_COLS, MIN_ROWS, cols, rows) + "\n");
      return;
    }
    paintCentered(out, lines, art, {
      cols, rows, palette, crownRows: stage.crownRows ?? 0, artWidth,
      ripple: rippleActive ? { start: rippleStart, now } : null,
      body: asleep ? palette.sleepBody : palette.body,
    });

    // 波紋中は 50ms 間隔の追加フレームで滑らかに描く
    if (rippleActive && !rippleTimer) {
      rippleTimer = setTimeout(() => { rippleTimer = null; renderTick(); }, 50);
    }
  };

  dataTick();
  renderTick();
  const scheduleScan = () => {
    nextScanAt = Date.now() + cfg.intervalMs;
    setTimeout(() => { dataTick(); scheduleScan(); }, cfg.intervalMs);
  };
  scheduleScan();
  setInterval(renderTick, RENDER_INTERVAL_MS);
  // リサイズ時は全消去して即再描画（残像で中央寄せがずれるのを防ぐ）
  out.on("resize", () => { out.write("\x1b[2J"); renderTick(); });
}

// 対話式プレビュー: 矢印でステージ(←→)と状態(↑↓)を切り替えて、本番と同じ色・
// 中央配置・アニメで確認する。idle/sleep/pet/ripple を含む
function interactivePreview(cfg) {
  const T = TEXTS[cfg.language];
  const palette = detectPalette();
  const out = process.stdout;
  const stdin = process.stdin;
  const GRAY = "\x1b[90m";
  let stage = 0;
  let st = 0;
  let rippleStart = Date.now();
  let speech = "";

  const refreshSpeech = () => {
    const state = PREVIEW_STATES[st];
    speech = state === "ripple"
      ? T.evolved(T.stageNames[stage])
      : pickSpeech({ stageIndex: stage, petted: state === "pet", asleep: state === "sleep", pace: 4_200_000, hour: 12, total: THRESHOLDS[stage] + 1 }, Math.random, cfg.language);
  };
  refreshSpeech();

  out.write("\x1b[?1049h\x1b[?25l");
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    out.write("\x1b[?25h\x1b[?1049l");
    if (stdin.isTTY && stdin.setRawMode) { try { stdin.setRawMode(false); } catch { /* noop */ } }
  };
  const quit = () => { cleanup(); process.exit(0); };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("exit", cleanup);

  const render = () => {
    const now = Date.now();
    const state = PREVIEW_STATES[st];
    const stageObj = STAGES[stage];
    const cols = out.columns || 80;
    const rows = out.rows || 24;
    // ループ再生は、最後の輪が画面外へ抜けきってから
    const rippleLife = rippleLifetimeMs(Math.sqrt(cols * cols + (rows * 2) * (rows * 2)));
    if (state === "ripple" && now - rippleStart >= rippleLife) rippleStart = now;
    const spec = previewSpec(stage, state, now);
    const footer = [
      `${GRAY} Stage ${stage + 1}/${STAGES.length} · ${state}${RESET}`,
      cfg.language === "ja"
        ? `${GRAY} <-/->ステージ ^/v状態 q:終了${RESET}`
        : `${GRAY} <-/-> stage ^/v state q:quit${RESET}`,
    ];
    if (cols < MIN_COLS || rows < MIN_ROWS + footer.length) {
      out.write("\x1b[H\x1b[2J" + T.widen(MIN_COLS, MIN_ROWS + footer.length, cols, rows) + "\n");
      return;
    }
    const artWidth = stageArtWidth(stageObj);
    const lines = composeScreen({
      artLines: spec.art, bubbleText: speech, stageIndex: stage, stageName: T.stageNames[stage], artWidth,
      total: spec.total, progress: spec.progress, ceil: spec.ceil, floor: spec.floor,
      pace: 4_200_000, cost: spec.total / 1e6 * 1.9, nextScanInMs: 120_000, lang: cfg.language,
      zzzPhase: spec.zzzPhase, heartPhase: spec.heartPhase,
    });
    paintCentered(out, lines, spec.art, {
      cols, rows, palette, crownRows: stageObj.crownRows ?? 0, artWidth,
      ripple: spec.rippleActive ? { start: rippleStart, now } : null,
      body: spec.sleepBody ? palette.sleepBody : palette.body,
      footer,
    });
  };

  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", (d) => {
      if (d.includes("\x03") || d.includes("q")) return quit();
      const seqs = d.match(/\x1b\[[ABCD]/g) || []; // まとめ押しも1つずつ処理
      let changed = false;
      for (const sq of seqs) {
        if (sq === "\x1b[C") stage = (stage + 1) % STAGES.length;
        else if (sq === "\x1b[D") stage = (stage - 1 + STAGES.length) % STAGES.length;
        else if (sq === "\x1b[A") st = (st - 1 + PREVIEW_STATES.length) % PREVIEW_STATES.length;
        else if (sq === "\x1b[B") st = (st + 1) % PREVIEW_STATES.length;
        changed = true;
      }
      if (changed) {
        if (PREVIEW_STATES[st] === "ripple") rippleStart = Date.now();
        refreshSpeech();
        render();
      }
    });
  }

  render();
  setInterval(render, 80);
  // リサイズ時は全消去して即再描画
  out.on("resize", () => { out.write("\x1b[2J"); render(); });
}

const HELP_TEXTS = {
  ja: `clawd-pet — Claude Code の日次トークン消費で育つターミナルペット

Usage: clawd-pet [flag]

Flags:
  (なし)      ペットを起動する。終了は Ctrl+C または q
  --once      今日の集計を1行出力して終了
  --preview   対話式プレビュー（←→でステージ, ↑↓で状態）
  --edit      Web ドット絵エディタをブラウザで起動
  --help      このヘルプ

ホイールを回すと撫でられて喜ぶ。終了は Ctrl+C または q

設定: ~/.config/clawd-pet/config.json（環境変数が優先）
  CLAWD_PET_LANG (ja/en) / CLAWD_PET_TZ / CLAWD_PET_THRESHOLDS
  CLAWD_PET_INTERVAL_SEC / CLAWD_PET_CONFIG_DIR / CLAWD_PET_NO_FETCH`,
  en: `clawd-pet — a terminal pet that grows with your daily Claude Code token usage

Usage: clawd-pet [flag]

Flags:
  (none)      run the pet (Ctrl+C or q to quit)
  --once      print today's stats once and exit
  --preview   interactive preview (<-/-> stage, ^/v state)
  --edit      open the web pixel-art editor in a browser
  --help      this help

Scroll the wheel to pet clawd. Quit with Ctrl+C or q

Config: ~/.config/clawd-pet/config.json (env vars take precedence)
  CLAWD_PET_LANG (ja/en) / CLAWD_PET_TZ / CLAWD_PET_THRESHOLDS
  CLAWD_PET_INTERVAL_SEC / CLAWD_PET_CONFIG_DIR / CLAWD_PET_NO_FETCH`,
};

// URL を開くOSコマンド（WSL は explorer.exe で Windows 既定ブラウザへ）
export function browserCommand(platform, isWsl, url) {
  if (isWsl) return { cmd: "explorer.exe", args: [url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

function openBrowser(url) {
  const isWsl = /microsoft/i.test(os.release());
  const { cmd, args } = browserCommand(process.platform, isWsl, url);
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch { /* 開けなくても URL は表示するので問題ない */ }
}

// Windows から WSL のサーバへ届くアドレス（eth0 の IPv4）。localhost 転送が
// 効かない環境向け。見つからなければ null。
export function wslHostIP() {
  const ifs = os.networkInterfaces();
  for (const name of ["eth0", ...Object.keys(ifs)]) {
    for (const i of ifs[name] || []) if (i.family === "IPv4" && !i.internal) return i.address;
  }
  return null;
}

// --edit: 同梱の Web ドット絵エディタを起動してブラウザで開く
async function launchEditor() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const serverPath = path.join(here, "clawd-web-editor", "server.mjs");
  if (!fs.existsSync(serverPath)) {
    console.log(`clawd-web-editor が見つからないわ: ${serverPath}`);
    process.exit(1);
  }
  const port = process.env.PORT || 4173;
  const probeUrl = `http://127.0.0.1:${port}`; // 存在確認は WSL 内の loopback で
  // ブラウザ用は、WSL かつ HOST 未指定なら WSL の IP（localhost 転送が効かない環境向け）
  const isWsl = /microsoft/i.test(os.release());
  const ip = !process.env.HOST && isWsl ? wslHostIP() : null;
  const browseUrl = `http://${process.env.HOST || ip || "127.0.0.1"}:${port}`;
  // ポートの状態を見極める: 接続拒否＝空き（起動してよい）、それ以外＝何か居る（bindしない）
  let probe;
  try {
    const res = await fetch(probeUrl + "/api/stages", { signal: AbortSignal.timeout(1500) });
    probe = res.ok ? "ours" : "other";
  } catch (e) {
    probe = (e?.cause?.code || e?.code) === "ECONNREFUSED" ? "free" : "other";
  }
  if (probe === "other") {
    console.log(`ポート ${port} が塞がっているわ。残ったプロセスがいるかも。`);
    console.log(`  解放するなら: pkill -f clawd-web-editor`);
  } else if (probe === "free") {
    const mod = await import(pathToFileURL(serverPath).href);
    mod.start(); // 空きのときだけ listen
  }
  console.log(`ブラウザで開いてね: ${browseUrl}`);
  openBrowser(browseUrl);
}

const KNOWN_FLAGS = new Set(["--once", "--preview", "--edit", "--help"]);

async function main() {
  const args = process.argv.slice(2);
  const lang = resolveConfig(process.env, loadConfigFile()).language;
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (args.includes("--help") || unknown.length > 0) {
    console.log(HELP_TEXTS[lang]);
    process.exit(unknown.length > 0 && !args.includes("--help") ? 1 : 0);
  }
  // プレビューは設定ファイルだけ見る（ウィザードや料金取得は不要）
  if (args.includes("--preview")) return interactivePreview(resolveConfig(process.env, loadConfigFile()));
  if (args.includes("--edit")) return launchEditor();
  let file = loadConfigFile();
  if (!file && process.stdin.isTTY && process.stdout.isTTY && !args.includes("--once")) {
    file = await firstRunWizard();
  }
  const cfg = resolveConfig(process.env, file);
  // 起動時に料金表を更新（失敗時はキャッシュ → 内蔵テーブル）
  await refreshPricing({ cacheFile: path.join(configDir(), "pricing-cache.json") });
  if (args.includes("--once")) return once(cfg);
  runLoop({ cfg });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const verr = nodeVersionError(process.version);
  if (verr) { console.error(verr); process.exit(1); }
  main();
}
