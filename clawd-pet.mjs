#!/usr/bin/env node
// clawd-pet — Claude Code の日次トークン消費で育つターミナルペット
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import readline from "node:readline/promises";

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

// 起動時に料金表を更新する。ネットワーク不可ならキャッシュ → 内蔵テーブルの順でフォールバック
export async function refreshPricing({ cacheFile, timeoutMs = 4000 } = {}) {
  if (process.env.CLAWD_PET_NO_FETCH) return "disabled";
  try {
    const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    activePricing = mergeLiteLLMPricing(PRICING, raw);
    if (cacheFile) {
      try {
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAt: new Date().toISOString(), pricing: activePricing }));
      } catch { /* キャッシュ書き込み失敗は無視 */ }
    }
    return "fetched";
  } catch {
    if (cacheFile) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
        if (cached?.pricing) {
          activePricing = { ...PRICING, ...cached.pricing };
          return "cache";
        }
      } catch { /* キャッシュなし */ }
    }
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

// ペースが算出できるようになるまでは 60 秒間隔でスキャンする（起動直後・日付またぎ直後の立ち上がり対策）
export function nextScanDelay(samples, intervalMs = DATA_INTERVAL_MS) {
  return computePace(samples) === null ? Math.min(60e3, intervalMs) : intervalMs;
}

export function computePace(samples) {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const span = last.t - first.t;
  if (span < 5 * 60e3) return null;
  return Math.max(0, ((last.total - first.total) / span) * 3600e3);
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
  return Math.round(pace / 1e3) + "K tokens/h";
}

export function createCollector(root, now = Date.now, tz = "Asia/Tokyo") {
  const files = new Map(); // path -> { offset, remainder }
  const daily = new Map(); // "YYYY-MM-DD" -> { tok, usd }
  const seen = new Set();  // "messageId:requestId"
  let seenDay = dayKey(now(), tz);

  function rollover(today) {
    seen.clear();
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
  }

  return {
    scan,
    todayTotal: () => daily.get(dayKey(now(), tz))?.tok || 0,
    todayCost: () => daily.get(dayKey(now(), tz))?.usd || 0,
  };
}

export const STAGES = [
  {
    name: "clawd",
    bellyRow: 1,
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
        "  ▗▟█████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▌",
        " ▝▜████████▛▘",
        "   ▘▘   ▝▝",
      ],
      [
        "   ▞      ▚",
        "  ▗▟█████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▌",
        " ▝▜████████▛▘",
        "   ▘▘   ▝▝",
      ],
    ],
    blink: [
      "   ▚      ▞",
      "  ▗▟█████▙▖",
      " ▐███▄██▄███▌",
      " ▐██████████▌",
      " ▝▜████████▛▘",
      "   ▘▘   ▝▝",
    ],
  },
  {
    name: "はたらきもの",
    bellyRow: 4,
    frames: [
      [
        "  ▟▙      ▟▙",
        "  ▗▟██████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▌▄▛",
        " ▝▜████████▛▘",
        "   ▘▘    ▝▝",
      ],
      [
        "  ▟▙      ▟▙",
        "  ▗▟██████▙▖",
        " ▐███ ██ ███▌",
        " ▐██████████▌▄▄",
        " ▝▜████████▛▘",
        "   ▘▘    ▝▝",
      ],
    ],
    blink: [
      "  ▟▙      ▟▙",
      "  ▗▟██████▙▖",
      " ▐███▄██▄███▌",
      " ▐██████████▌▄▛",
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
    bellyRow: 7,
    crownRows: 2,
    frames: [
      [
        "       █ █ █",
        "       █████",
        "   ▟▙          ▟▙",
        "  ▗▟████████████▙▖",
        " ▐█████ ███ █████▌",
        " ▐████████████████▌ ▗▖",
        " ▐████████████████▙▄▟▛▘",
        " ▐████████████████▌",
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
        " ▐████████████████▌",
        " ▐████████████████▙▄▟▖",
        " ▐████████████████▌",
        " ▝▜██████████████▛▘",
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
      " ▐████████████████▌ ▗▖",
      " ▐████████████████▙▄▟▛▘",
      " ▐████████████████▌",
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
  const out = rows.slice();
  for (let r = 0; r < stage.bellyRow; r++) {
    const above = r > 0 ? rows[r - 1] : "";
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
  const artW = Math.max(...art.map(strWidth));
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
    widen: (c, r) => `  ウィンドウを ひろげてね（よこ${c} × たて${r} いじょう）`,
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
    widen: (c, r) => `  please widen the window (min ${c} x ${r})`,
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

export const MIN_COLS = maxContentWidth() + 2;

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

function preview() {
  for (let i = 0; i < STAGES.length; i++) {
    const st = STAGES[i];
    console.log(`\n=== Stage ${i + 1}: ${st.name}（しきい値 ${THRESHOLDS[i].toLocaleString("en-US")}） ===`);
    st.frames.forEach((frame, j) => {
      console.log(`--- frame ${j} ---`);
      console.log(frame.join("\n"));
    });
    if (st.blink) {
      console.log("--- blink ---");
      console.log(st.blink.join("\n"));
    }
  }
}

// 進化エフェクト: 本家 ultracode 選択時の波紋（UltraRippleText）の再現
// グラデーション端点 rgb(62,22,118)→rgb(140,80,240)、波長 20 セル、速度 0.03 セル/ms は本家バイナリの定数
export const RIPPLE_RAMP = Array.from({ length: 8 }, (_, i) => {
  const t = i / 7;
  const lerp = (a, b) => Math.round(a + (b - a) * t);
  return [lerp(62, 140), lerp(22, 80), lerp(118, 240)];
});
const RIPPLE_WAVELENGTH = 20;
const RIPPLE_SPEED = 0.03;            // セル/ms
export const RIPPLE_DURATION_MS = 4000;
const RIPPLE_W = 56;                  // 波紋を塗る既定幅

export function rippleLevel(dist, travel) {
  if (dist > travel) return null;
  const q = (((dist - travel) % RIPPLE_WAVELENGTH) + RIPPLE_WAVELENGTH) % RIPPLE_WAVELENGTH;
  const k = (1 + Math.cos((2 * Math.PI * q) / RIPPLE_WAVELENGTH)) / 2;
  return Math.min(RIPPLE_RAMP.length - 1, Math.round(k * (RIPPLE_RAMP.length - 1)));
}

// 各行を波紋の背景色つき ANSI 文字列にする。覆われていない部分は baseColors[r] で描く
export function applyRipple(lines, origin, travel, baseColors, width = RIPPLE_W) {
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
      const level = rippleLevel(Math.sqrt(dx * dx + dy * dy), travel);
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
async function firstRunWizard() {
  const sysTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  // EOF や中断は「既定値で続行」扱いにする
  const ask = async (q) => { try { return (await rl.question(q)).trim(); } catch { return ""; } };
  let language, timezone;
  try {
    const langIn = await ask("Language / 言語:  1) 日本語  2) English  [1]: ");
    language = langIn === "2" ? "en" : "ja";
    const tzIn = await ask(`Timezone (IANA) [${sysTz}]: `);
    timezone = tzIn || sysTz;
    try { dayKey(Date.now(), timezone); } catch {
      console.log(`  unknown timezone "${timezone}" — using ${sysTz}`);
      timezone = sysTz;
    }
  } finally {
    rl.close();
  }
  const cfg = { language, timezone, thresholds: THRESHOLDS, intervalSeconds: DATA_INTERVAL_MS / 1000 };
  fs.mkdirSync(configDir(), { recursive: true });
  const file = path.join(configDir(), "config.json");
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  console.log(`  saved: ${file}`);
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

function runLoop(opts = {}) {
  const cfg = opts.cfg ?? resolveConfig(process.env, loadConfigFile());
  const T = TEXTS[cfg.language];
  const palette = detectPalette();
  const collector = createCollector(PROJECTS_ROOT, Date.now, cfg.timezone);
  let samples = [];
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
    if (today !== lastDay) { samples = []; lastDay = today; } // 日付またぎでペースをリセット
    collector.scan();
    const tot = collector.todayTotal();
    if (tot > lastTotalSeen) { lastGrowthAt = now; lastTotalSeen = tot; }
    samples.push({ t: now, total: tot });
    samples = samples.filter((s) => now - s.t <= 3600e3); // 直近 1 時間分だけ保持
  };

  const renderTick = () => {
    const now = Date.now();
    const total = collector.todayTotal();
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
    const rippleActive = rippleStart !== null && now - rippleStart < RIPPLE_DURATION_MS;
    const petted = !rippleActive && (opts.demoPet || now - lastPetAt < PET_DURATION_MS);
    const asleep = !rippleActive && !petted && (opts.demoSleep || now - lastGrowthAt >= SLEEP_AFTER_MS);

    if (now >= frameToggleAt) { frameIdx++; frameToggleAt = now + 1000; }
    if (now >= nextBlinkAt) { blinkUntil = now + 400; nextBlinkAt = now + 4000 + Math.random() * 6000; }
    // 寝姿: 目を閉じて、2秒周期でお腹が縮む（呼吸）。撫でられ中も目を細めて嬉しそうに
    const exhale = asleep && Math.floor(now / 2000) % 2 === 1;
    const art = (asleep || petted)
      ? (exhale ? breathArt(stage) : stage.blink)
      : (stage.blink && now < blinkUntil ? stage.blink : stage.frames[frameIdx % stage.frames.length]);

    if (now - lastSpeechAt >= SPEECH_INTERVAL_MS) {
      speech = pickSpeech({ stageIndex: s.index, pace: computePace(samples), hour: hourIn(now, cfg.timezone), total, asleep }, Math.random, cfg.language);
      lastSpeechAt = now;
    }
    if (asleep && !T.pools.asleep.includes(speech)) {
      // 眠った瞬間にセリフも寝かせる
      speech = pickSpeech({ stageIndex: s.index, pace: null, hour: hourIn(now, cfg.timezone), total, asleep: true }, Math.random, cfg.language);
      lastSpeechAt = now;
    }

    const cols = out.columns || 80;
    const rows = out.rows || 24;
    const lines = composeScreen({
      artLines: art, bubbleText: speech, stageIndex: s.index, stageName,
      total, progress: s.progress, ceil: s.ceil, floor: s.floor, pace: computePace(samples),
      cost: collector.todayCost(), nextScanInMs: nextScanAt - now, lang: cfg.language,
      zzzPhase: asleep ? Math.floor(now / 1000) % 3 : null,
      heartPhase: petted ? Math.floor(now / 300) % 3 : null,
    });
    // 必要サイズは最終形態を基準に固定。一度合わせれば成長してもメッセージは出ない
    if (cols < MIN_COLS || rows < MIN_ROWS) {
      out.write("\x1b[H\x1b[2J" + T.widen(MIN_COLS, MIN_ROWS) + "\n");
      return;
    }
    // 詰めるのは成長余白（アートが低いぶんの上部空行）だけ。吹き出し領域の3行は
    // 保つ（ハートや Zzz は上端が空でも、その空きを詰めると縦位置がずれてしまう）
    const maxTrim = ART_H - art.length;
    let lead = 0;
    while (lead < maxTrim && lines[lead] === "") lead++;
    const fitted = lines.slice(lead);
    const trimmed = lead;

    // 横方向の中央寄せ: コンテンツの左端 L〜右端 R を端末幅の中央へ
    let L = Infinity, R = 0;
    for (const l of fitted) {
      if (l === "") continue;
      L = Math.min(L, l.length - l.trimStart().length);
      R = Math.max(R, strWidth(l));
    }
    if (!Number.isFinite(L)) L = 0;
    const leftPad = Math.max(0, Math.floor((cols - L - R) / 2));
    const topPad = Math.max(0, Math.floor((rows - 1 - fitted.length) / 2));

    let rendered;
    if (rippleActive) {
      // 波紋の原点はペットの中心
      const origin = {
        col: AXIS_COL,
        row: BUBBLE_H + (ART_H - art.length) + Math.floor(art.length / 2) - trimmed,
      };
      const travel = (now - rippleStart) * RIPPLE_SPEED;
      const top = topLineColors(art.length, stage.crownRows ?? 0, palette);
      const baseColors = fitted.map((_, i) => (i + trimmed < top.length ? top[i + trimmed] : ""));
      rendered = applyRipple(fitted, origin, travel, baseColors, R);
    } else {
      const body = asleep ? palette.sleepBody : palette.body;
      const top = topLineColors(art.length, stage.crownRows ?? 0, { ...palette, body });
      rendered = fitted.map((line, i) => (i + trimmed < top.length ? top[i + trimmed] + line + RESET : line));
    }
    const pad = " ".repeat(leftPad);
    let buf = "\x1b[H";
    for (let i = 0; i < topPad; i++) buf += "\x1b[K\n";
    for (const line of rendered) buf += pad + line + "\x1b[K\n";
    buf += "\x1b[J";
    out.write(buf);

    // 波紋中は 50ms 間隔の追加フレームで滑らかに描く
    if (rippleActive && !rippleTimer) {
      rippleTimer = setTimeout(() => { rippleTimer = null; renderTick(); }, 50);
    }
  };

  dataTick();
  renderTick();
  const scheduleScan = () => {
    const delay = nextScanDelay(samples, cfg.intervalMs);
    nextScanAt = Date.now() + delay;
    setTimeout(() => { dataTick(); scheduleScan(); }, delay);
  };
  scheduleScan();
  setInterval(renderTick, RENDER_INTERVAL_MS);
}

const HELP_TEXTS = {
  ja: `clawd-pet — Claude Code の日次トークン消費で育つターミナルペット

Usage: clawd-pet [flag]

Flags:
  (なし)      ペットを起動する。終了は Ctrl+C
  --once      今日の集計を1行出力して終了
  --preview   全ステージのアートを一覧表示
  --ripple    起動直後に進化エフェクトを試し見
  --sleep     寝姿を試し見
  --pet       撫でられ状態を試し見
  --help      このヘルプ

ホイールを回すと撫でられて喜ぶ。終了は Ctrl+C または q

設定: ~/.config/clawd-pet/config.json（環境変数が優先）
  CLAWD_PET_LANG (ja/en) / CLAWD_PET_TZ / CLAWD_PET_THRESHOLDS
  CLAWD_PET_INTERVAL_SEC / CLAWD_PET_CONFIG_DIR / CLAWD_PET_NO_FETCH`,
  en: `clawd-pet — a terminal pet that grows with your daily Claude Code token usage

Usage: clawd-pet [flag]

Flags:
  (none)      run the pet (Ctrl+C to quit)
  --once      print today's stats once and exit
  --preview   show all stage art
  --ripple    demo the evolution ripple on launch
  --sleep     demo the sleeping pose
  --pet       demo the petted reaction
  --help      this help

Scroll the wheel to pet clawd. Quit with Ctrl+C or q

Config: ~/.config/clawd-pet/config.json (env vars take precedence)
  CLAWD_PET_LANG (ja/en) / CLAWD_PET_TZ / CLAWD_PET_THRESHOLDS
  CLAWD_PET_INTERVAL_SEC / CLAWD_PET_CONFIG_DIR / CLAWD_PET_NO_FETCH`,
};

const KNOWN_FLAGS = new Set(["--once", "--preview", "--ripple", "--sleep", "--pet", "--help"]);

async function main() {
  const args = process.argv.slice(2);
  const lang = resolveConfig(process.env, loadConfigFile()).language;
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.has(a));
  if (args.includes("--help") || unknown.length > 0) {
    console.log(HELP_TEXTS[lang]);
    process.exit(unknown.length > 0 && !args.includes("--help") ? 1 : 0);
  }
  if (args.includes("--preview")) return preview();
  let file = loadConfigFile();
  if (!file && process.stdin.isTTY && process.stdout.isTTY && !args.includes("--once")) {
    file = await firstRunWizard();
  }
  const cfg = resolveConfig(process.env, file);
  // 起動時に料金表を更新（失敗時はキャッシュ → 内蔵テーブル）
  await refreshPricing({ cacheFile: path.join(configDir(), "pricing-cache.json") });
  if (args.includes("--once")) return once(cfg);
  // --ripple: 波紋 / --sleep: 寝姿 / --pet: 撫でられ を試し見
  runLoop({ demoRipple: args.includes("--ripple"), demoSleep: args.includes("--sleep"), demoPet: args.includes("--pet"), cfg });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
