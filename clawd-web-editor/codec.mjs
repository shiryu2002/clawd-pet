// codec.mjs — Clawd ペットのドット絵と clawd-pet.mjs ソースの相互変換。
// 副作用なしの純粋関数だけで構成し、ブラウザと Node の双方から import できる。
//
// 本体のアートは 4 象限ブロック文字でできている。各文字は 2×2 のサブピクセルを
// 表すので、エディタ側では「ドット（サブピクセル）」のグリッドとして扱い、保存・
// 適用の直前に QUAD 文字へ畳み込む。

// index = UL(1) | UR(2) | LL(4) | LR(8)
export const QUAD_CHARS = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█";
export const QUAD_OF = Object.fromEntries([...QUAD_CHARS].map((c, i) => [c, i]));

export const UL = 1, UR = 2, LL = 4, LR = 8;

// アート（文字列の配列）→ ドットグリッド { h, w, pixels }。
// pixels[y][x] は真偽値。h = 行数*2、w = 最大文字幅*2。
export function decodeArt(rows) {
  const charH = rows.length;
  let charW = 0;
  for (const row of rows) charW = Math.max(charW, [...row].length);
  const h = charH * 2;
  const w = charW * 2;
  const pixels = Array.from({ length: h }, () => new Array(w).fill(false));
  rows.forEach((row, r) => {
    [...row].forEach((ch, c) => {
      const bits = QUAD_OF[ch] ?? 0;
      if (bits & UL) pixels[r * 2][c * 2] = true;
      if (bits & UR) pixels[r * 2][c * 2 + 1] = true;
      if (bits & LL) pixels[r * 2 + 1][c * 2] = true;
      if (bits & LR) pixels[r * 2 + 1][c * 2 + 1] = true;
    });
  });
  return { h, w, pixels };
}

// ドットグリッド → アート（文字列の配列）。各行末の空白は本体に合わせて落とす。
export function encodeArt(pixels) {
  const h = pixels.length;
  const w = h ? pixels[0].length : 0;
  const rows = [];
  for (let r = 0; r * 2 < h; r++) {
    let line = "";
    for (let c = 0; c * 2 < w; c++) {
      const ul = pixels[r * 2]?.[c * 2] ? UL : 0;
      const ur = pixels[r * 2]?.[c * 2 + 1] ? UR : 0;
      const ll = pixels[r * 2 + 1]?.[c * 2] ? LL : 0;
      const lr = pixels[r * 2 + 1]?.[c * 2 + 1] ? LR : 0;
      line += QUAD_CHARS[ul | ur | ll | lr];
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows;
}

// アート群を全部 1 つのドットグリッドに重ねて、共通のサイズを返す。
// （エディタでステージ内のフレーム/まばたきを同じキャンバスサイズで扱うため）
export function gridSizeForArts(arts) {
  let charH = 0, charW = 0;
  for (const rows of arts) {
    charH = Math.max(charH, rows.length);
    for (const row of rows) charW = Math.max(charW, [...row].length);
  }
  return { rows: charH, cols: charW };
}

// 真偽の 2 次元配列を作る（h 行 × w 列）。
export function makePixels(h, w) {
  return Array.from({ length: h }, () => new Array(w).fill(false));
}

// アートを指定サイズ（文字単位 rows×cols）のドットグリッドへ。足りない分は空白。
export function artToPixels(rows, charRows, charCols) {
  const pixels = makePixels(charRows * 2, charCols * 2);
  rows.forEach((row, r) => {
    if (r * 2 >= charRows * 2) return;
    [...row].forEach((ch, c) => {
      if (c * 2 >= charCols * 2) return;
      const bits = QUAD_OF[ch] ?? 0;
      if (bits & UL) pixels[r * 2][c * 2] = true;
      if (bits & UR) pixels[r * 2][c * 2 + 1] = true;
      if (bits & LL) pixels[r * 2 + 1][c * 2] = true;
      if (bits & LR) pixels[r * 2 + 1][c * 2 + 1] = true;
    });
  });
  return pixels;
}

// ドットグリッドを左右反転（プレビューや「逆向きを作る」用途）。
export function flipPixelsH(pixels) {
  return pixels.map((row) => [...row].reverse());
}

const FLAG_KEYS = ["noBreath", "petOpen"]; // true のときだけ出力する真偽フラグ

// 1 ステージを clawd-pet.mjs の体裁で文字列化する。
export function serializeStage(stage, indent = "  ") {
  const i1 = indent;
  const i2 = indent + "  ";
  const i3 = indent + "    ";
  const i4 = indent + "      ";
  const out = [];
  out.push(`${i1}{`);
  out.push(`${i2}name: ${JSON.stringify(stage.name)},`);
  out.push(`${i2}bellyRow: ${stage.bellyRow},`);
  for (const key of FLAG_KEYS) {
    if (stage[key]) out.push(`${i2}${key}: true,`);
  }
  if (stage.crownRows != null) out.push(`${i2}crownRows: ${stage.crownRows},`);
  out.push(`${i2}frames: [`);
  for (const frame of stage.frames) {
    out.push(`${i3}[`);
    for (const row of frame) out.push(`${i4}${JSON.stringify(row)},`);
    out.push(`${i3}],`);
  }
  out.push(`${i2}],`);
  out.push(`${i2}blink: [`);
  for (const row of stage.blink) out.push(`${i3}${JSON.stringify(row)},`);
  out.push(`${i2}],`);
  out.push(`${i1}},`);
  return out.join("\n");
}

// STAGES 配列全体を `export const STAGES = [ ... ];` の形で文字列化する。
export function serializeStages(stages) {
  const body = stages.map((s) => serializeStage(s)).join("\n");
  return `export const STAGES = [\n${body}\n];`;
}

// ソース中の `export const STAGES = [ ... ];` の範囲を返す。
// アート行や name にブラケットは現れないため、単純なブラケット対応で安全に切り出せる。
export function findStagesRange(source) {
  const marker = "export const STAGES = [";
  const start = source.indexOf(marker);
  if (start < 0) throw new Error("STAGES の定義が見つからない");
  const bracketStart = start + marker.length - 1; // 先頭の '[' の位置
  let depth = 0;
  let i = bracketStart;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error("STAGES の閉じ括弧が見つからない");
  let end = i + 1;
  if (source[end] === ";") end++;
  return { start, end };
}

// ソース中の STAGES 定義を、与えた stages で置き換えた新ソースを返す。
export function replaceStagesInSource(source, stages) {
  const { start, end } = findStagesRange(source);
  return source.slice(0, start) + serializeStages(stages) + source.slice(end);
}

// ── セリフ（TEXTS.<lang>.pools）の相互変換 ──────────────────────────

// pools オブジェクト → `pools: { ... }` の文字列（キー順は渡された順を維持）。
// baseIndent は `pools` キーの字下げ（clawd-pet.mjs では4スペース）。
export function serializePools(pools, baseIndent = "    ") {
  const cat = baseIndent + "  ";
  const item = baseIndent + "    ";
  const lines = ["pools: {"];
  for (const [key, arr] of Object.entries(pools)) {
    lines.push(`${cat}${key}: [`);
    for (const s of arr) lines.push(`${item}${JSON.stringify(s)},`);
    lines.push(`${cat}],`);
  }
  lines.push(`${baseIndent}}`);
  return lines.join("\n");
}

// 受け取った pools を「キー: 文字列配列（空行は除く）」に正規化する。
export function normalizePools(pools) {
  const out = {};
  for (const [key, arr] of Object.entries(pools || {})) {
    out[key] = (Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean);
  }
  return out;
}

// source 中の fromIndex 以降にある最初の `pools: {` の範囲を返す（無ければ null）。
function findPoolsRange(source, fromIndex) {
  const marker = "pools: {";
  const start = source.indexOf(marker, fromIndex);
  if (start < 0) return null;
  let depth = 0, i = start + marker.length - 1; // '{' の位置
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) break; }
  }
  if (depth !== 0) throw new Error("pools の閉じ括弧が見つからない");
  return { start, end: i + 1 };
}

// TEXTS 内の ja / en の pools ブロックを順に置換する。
// langs = { ja?: poolsObj, en?: poolsObj }（出現順は ja → en）。
export function replacePoolsInSource(source, langs) {
  let result = source;
  let from = 0;
  for (const lang of ["ja", "en"]) {
    const r = findPoolsRange(result, from);
    if (!r) throw new Error("pools の定義が見つからない");
    if (langs[lang]) {
      const replacement = serializePools(langs[lang]);
      result = result.slice(0, r.start) + replacement + result.slice(r.end);
      from = r.start + replacement.length;
    } else {
      from = r.end;
    }
  }
  return result;
}

// ── 設定値（export const の数値/配列）の置換 ─────────────────────────

// `export const NAME = <値>;` の範囲を返す（値は最初の ';' まで）。
export function findConstRange(source, name) {
  const re = new RegExp("export const " + name + "\\s*=\\s*");
  const m = re.exec(source);
  if (!m) return null;
  const valStart = m.index + m[0].length;
  const semi = source.indexOf(";", valStart);
  if (semi < 0) return null;
  return { start: m.index, valStart, valEnd: semi, end: semi + 1 };
}

export function serializeConstValue(raw) {
  return Array.isArray(raw) ? `[${raw.join(", ")}]` : String(raw);
}

// rawByName = { NAME: number | number[] } の各定数値を置換する。
export function replaceConstsInSource(source, rawByName) {
  let result = source;
  for (const [name, raw] of Object.entries(rawByName)) {
    const r = findConstRange(result, name);
    if (!r) throw new Error(`定数 ${name} が見つからない`);
    result = result.slice(0, r.valStart) + serializeConstValue(raw) + result.slice(r.valEnd);
  }
  return result;
}

// エディタで編集できる設定の一覧（A: 成長/睡眠, B: タイミング, C: 波紋）。
// target=source は clawd-pet.mjs の定数、target=config は config.json を書き換える。
export const SETTINGS_FIELDS = [
  { key: "thresholds", label: "進化しきい値（M tokens, カンマ区切り）", group: "A", target: "config", cfgKey: "thresholds", unit: "Mtok" },
  { key: "sleep", label: "睡眠までの無活動（分）", group: "A", target: "source", name: "SLEEP_AFTER_MS", unit: "min" },
  { key: "scan", label: "集計スキャン間隔（秒）", group: "B", target: "config", cfgKey: "intervalSeconds", unit: "sec-raw" },
  { key: "render", label: "アニメ描画間隔（ms）", group: "B", target: "source", name: "RENDER_INTERVAL_MS", unit: "ms" },
  { key: "speech", label: "セリフ入替間隔（秒）", group: "B", target: "source", name: "SPEECH_INTERVAL_MS", unit: "sec" },
  { key: "pet", label: "撫でられ継続（秒）", group: "B", target: "source", name: "PET_DURATION_MS", unit: "sec" },
  { key: "pace", label: "ペース集計の窓（分）", group: "B", target: "source", name: "PACE_WINDOW_MS", unit: "min" },
  { key: "rDur", label: "波紋の再生（秒）", group: "C", target: "source", name: "RIPPLE_DURATION_MS", unit: "sec" },
  { key: "rSpeed", label: "波紋の速さ（cell/ms）", group: "C", target: "source", name: "RIPPLE_SPEED", unit: "float" },
  { key: "rWave", label: "波紋の波長（cell）", group: "C", target: "source", name: "RIPPLE_WAVELENGTH", unit: "int" },
  { key: "rFrom", label: "波紋の色・内側（R,G,B）", group: "C", target: "source", name: "RIPPLE_COLOR_FROM", unit: "rgb" },
  { key: "rTo", label: "波紋の色・外側（R,G,B）", group: "C", target: "source", name: "RIPPLE_COLOR_TO", unit: "rgb" },
];

// 内部 raw 値 → 入力欄の表示文字列
export function settingToDisplay(unit, raw) {
  switch (unit) {
    case "Mtok": return (raw || []).map((n) => n / 1e6).join(", ");
    case "min": return String(raw / 60000);
    case "sec": return String(raw / 1000);
    case "rgb": return (raw || []).join(", ");
    default: return String(raw); // sec-raw / ms / float / int
  }
}

// 入力欄の文字列 → 内部 raw 値（保存・適用に使う）
export function displayToSetting(unit, str) {
  const nums = String(str).split(",").map((s) => Number(s.trim()));
  switch (unit) {
    case "Mtok": return nums.map((m) => Math.round(m * 1e6));
    case "min": return Math.round(nums[0] * 60000);
    case "sec": return Math.round(nums[0] * 1000);
    case "ms": return Math.round(nums[0]);
    case "int": return Math.round(nums[0]);
    case "rgb": return nums.slice(0, 3).map((n) => Math.round(n));
    default: return nums[0]; // sec-raw / float
  }
}

// ステージのメタ情報だけを抜き出す（保存 JSON 用に正規化）。
export function normalizeStage(stage) {
  const out = {
    name: String(stage.name ?? ""),
    bellyRow: Number(stage.bellyRow ?? 0),
    frames: (stage.frames ?? []).map((f) => f.map(String)),
    blink: (stage.blink ?? []).map(String),
  };
  if (stage.noBreath) out.noBreath = true;
  if (stage.petOpen) out.petOpen = true;
  if (stage.crownRows != null) out.crownRows = Number(stage.crownRows);
  return out;
}
