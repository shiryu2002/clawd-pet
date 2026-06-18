import { test } from "node:test";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  JST_OFFSET_MS, THRESHOLDS,
  dayKeyJST, jstMidnightMs, parseUsageLine,
  stageFor, computeHourPace,
  strWidth, makeBubble, gauge, formatPace,
  createCollector,
  pickSpeech,
  composeScreen, ART_H, BUBBLE_H, STAGES,
  PRICING, formatCost, rippleLevel, RIPPLE_RAMP, DATA_INTERVAL_MS,
  formatTokensShort, topLineColors, SLEEP_AFTER_MS, formatCountdown,
  maxContentWidth, MIN_COLS, MIN_ROWS, maxContentHeight, SPEECH_POOLS, fitLines, zzzLines, breathArt,
  dayKey, midnightMs, resolveConfig, mergeLiteLLMPricing, TEXTS,
  parseMouseEvents, heartLines, PET_DURATION_MS,
  previewSpec, PREVIEW_STATES, browserCommand,
} from "../clawd-pet.mjs";

test("scaffold: 定数が読める", () => {
  assert.equal(THRESHOLDS.length, 6);
  assert.equal(JST_OFFSET_MS, 9 * 3600e3);
});

test("dayKeyJST: UTC→JST の日付変換", () => {
  assert.equal(dayKeyJST(Date.parse("2026-06-11T15:30:00Z")), "2026-06-12"); // JST 00:30
  assert.equal(dayKeyJST(Date.parse("2026-06-11T14:59:59Z")), "2026-06-11"); // JST 23:59
});

test("jstMidnightMs: その日の JST 0時を返す", () => {
  const t = Date.parse("2026-06-11T10:00:00+09:00");
  assert.equal(jstMidnightMs(t), Date.parse("2026-06-11T00:00:00+09:00"));
});

const VALID_LINE = JSON.stringify({
  timestamp: "2026-06-11T03:00:00.000Z",
  requestId: "req_011",
  message: {
    id: "msg_01",
    usage: { input_tokens: 2, output_tokens: 313, cache_creation_input_tokens: 1660, cache_read_input_tokens: 31440 },
  },
});

test("parseUsageLine: 正常行から key/day/tokens を抽出", () => {
  const p = parseUsageLine(VALID_LINE);
  assert.equal(p.tokens, 2 + 313 + 1660 + 31440);
  assert.equal(p.key, "msg_01:req_011");
  assert.equal(p.day, "2026-06-11"); // JST 12:00
});

test("parseUsageLine: 不正な行は null", () => {
  assert.equal(parseUsageLine('{"type":"mode"}'), null);            // usage なし
  assert.equal(parseUsageLine('{"usage": broken json'), null);      // 壊れた JSON
  assert.equal(parseUsageLine(JSON.stringify({ message: { usage: { input_tokens: 1 } } })), null); // timestamp なし
});

test("stageFor: 閾値の境界", () => {
  assert.equal(stageFor(0).index, 0);
  assert.equal(stageFor(1_999_999).index, 0);
  assert.equal(stageFor(2_000_000).index, 1);
  assert.equal(stageFor(199_999_999).index, 4);
  const max = stageFor(200_000_000);
  assert.equal(max.index, 5);
  assert.equal(max.ceil, null);
  assert.equal(max.progress, 1);
});

test("stageFor: progress は現ステージ内の進捗率", () => {
  const s = stageFor(6_000_000); // stage2: floor 2M, ceil 10M
  assert.equal(s.floor, 2_000_000);
  assert.equal(s.ceil, 10_000_000);
  assert.equal(s.progress, 0.5);
});

test("computeHourPace: 直近1時間に書かれたトークン量を合計する", () => {
  const now = 10 * 3600e3;
  const entries = [
    { ts: now - 90 * 60e3, tokens: 1000 }, // 1.5時間前 → 範囲外
    { ts: now - 30 * 60e3, tokens: 2000 }, // 30分前 → 算入
    { ts: now - 5 * 60e3, tokens: 3000 },  // 5分前 → 算入
    { ts: now, tokens: 500 },              // たった今 → 算入
  ];
  assert.equal(computeHourPace(entries, now), 2000 + 3000 + 500);
  assert.equal(computeHourPace([], now), 0); // データなしは 0
  assert.equal(computeHourPace([{ ts: now - 2 * 3600e3, tokens: 9 }], now), 0); // 全部1時間より前
});

test("strWidth: 全角は 2、半角・罫線・ブロックは 1", () => {
  assert.equal(strWidth("abc"), 3);
  assert.equal(strWidth("きょう"), 6);
  assert.equal(strWidth("─│╭"), 3);
  assert.equal(strWidth("▐█▛"), 3);
});

test("makeBubble: 上下枠と本文の表示幅が一致する", () => {
  const b = makeBubble("きょうも がんばろ");
  assert.equal(b.length, 3);
  assert.equal(strWidth(b[0]), strWidth(b[1]));
  assert.equal(strWidth(b[1]), strWidth(b[2]));
  assert.ok(b[1].includes("きょうも がんばろ"));
});

test("gauge: 進捗率を幅で塗る", () => {
  assert.equal(gauge(0.5, 10), "█████░░░░░");
  assert.equal(gauge(0, 4), "░░░░");
  assert.equal(gauge(1.5, 4), "████"); // 1 超はクランプ
});

test("formatPace: null は計測中、それ以外は単位付き", () => {
  assert.equal(formatPace(null), "計測中…");
  assert.equal(formatPace(4_200_000), "4.2M tokens/h");
  assert.equal(formatPace(50_000), "50K tokens/h");
  assert.equal(formatPace(0), "0 tokens/h");
});

function usageLine({ id, req, ts, out = 100 }) {
  return JSON.stringify({
    timestamp: ts,
    requestId: req,
    message: { id, usage: { input_tokens: 10, output_tokens: out, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
  }) + "\n";
}

test("createCollector: 集計・重複排除・追記・日付またぎ", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pet-test-"));
  const proj = path.join(root, "-home-user-proj");
  fs.mkdirSync(proj);
  const f = path.join(proj, "session1.jsonl");

  let NOW = Date.now();
  const nowFn = () => NOW;
  const tsToday = new Date(NOW).toISOString();

  fs.writeFileSync(f, [
    usageLine({ id: "m1", req: "r1", ts: tsToday }),            // 110
    usageLine({ id: "m1", req: "r1", ts: tsToday }),            // 重複 → 無視
    usageLine({ id: "m2", req: "r2", ts: tsToday, out: 200 }),  // 210
    '{"usage": broken\n',                                        // 壊れ行 → 無視
  ].join(""));

  const c = createCollector(root, nowFn);
  c.scan();
  assert.equal(c.todayTotal(), 110 + 210);
  // コストも同時に集計される（モデル未指定 → opus 4.5+ フォールバック料金）
  // m1: 10/1e6*5 + 100/1e6*25 = 0.00255, m2: 10/1e6*5 + 200/1e6*25 = 0.00505
  assert.ok(Math.abs(c.todayCost() - 0.0076) < 1e-9, `got ${c.todayCost()}`);

  // 追記分のみ読まれる
  fs.appendFileSync(f, usageLine({ id: "m3", req: "r3", ts: tsToday }));
  c.scan();
  assert.equal(c.todayTotal(), 110 + 210 + 110);

  // ファイル縮小 → 先頭から読み直し。既知キーは dedup され、新キーだけ加算
  fs.writeFileSync(f, usageLine({ id: "m4", req: "r4", ts: tsToday }));
  c.scan();
  assert.equal(c.todayTotal(), 110 + 210 + 110 + 110);

  // 日付またぎ → 今日の合計は 0 に戻る
  NOW += 24 * 3600e3;
  c.scan();
  assert.equal(c.todayTotal(), 0);
  assert.equal(c.todayCost(), 0);

  fs.rmSync(root, { recursive: true, force: true });
});

test("createCollector: 今日より古い mtime のファイルは中身を読まない", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-pet-test-"));
  const proj = path.join(root, "-old-proj");
  fs.mkdirSync(proj);
  const f = path.join(proj, "old.jsonl");
  const NOW = Date.now();
  // タイムスタンプは今日だが mtime を 3 日前にする（過去日に書かれた扱い）
  fs.writeFileSync(f, usageLine({ id: "m1", req: "r1", ts: new Date(NOW).toISOString() }));
  const old = new Date(NOW - 3 * 24 * 3600e3);
  fs.utimesSync(f, old, old);

  const c = createCollector(root, () => NOW);
  c.scan();
  assert.equal(c.todayTotal(), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("pickSpeech: 文脈でプールが切り替わる（rand 固定で決定的）", () => {
  const r0 = () => 0;
  const base = { stageIndex: 2, pace: 1_000_000, hour: 14, total: 15_000_000 };
  const generic = pickSpeech(base, r0);
  const night = pickSpeech({ ...base, hour: 2 }, r0);
  const burning = pickSpeech({ ...base, pace: 25_000_000 }, r0);
  const quiet = pickSpeech({ ...base, total: 0 }, r0);
  const legend = pickSpeech({ ...base, stageIndex: 5 }, r0);
  const all = [generic, night, burning, quiet, legend];
  assert.equal(new Set(all).size, all.length); // 全部違うプールから出ている
  for (const s of all) assert.equal(typeof s, "string");
});

test("composeScreen: 全ステージでレイアウトが組める", () => {
  for (let i = 0; i < STAGES.length; i++) {
    const s = stageFor(THRESHOLDS[i]);
    const lines = composeScreen({
      artLines: STAGES[i].frames[0],
      bubbleText: "てすと",
      stageIndex: s.index,
      stageName: STAGES[i].name,
      total: THRESHOLDS[i],
      progress: s.progress,
      ceil: s.ceil,
      pace: 4_200_000,
      cost: 12.34,
      nextScanInMs: 154_000,
    });
    assert.equal(lines.length, BUBBLE_H + ART_H + 7); // 吹き出し + アート枠 + 空行 + ステータス6行
    assert.ok(lines.some((l) => l.includes(`Stage ${i + 1}`)));
    assert.ok(lines.some((l) => l.includes("Today")));
    // M 表記のみ（例: "Today : 16.3M tokens"）
    if (THRESHOLDS[i] >= 1e6) {
      assert.ok(lines.some((l) => /Today : [\d.]+M tokens$/.test(l)), lines.join("\n"));
    }
    assert.ok(lines.some((l) => l.includes("4.2M tokens/h")));
    assert.ok(lines.some((l) => l.includes("$12.34")));
    assert.ok(lines.some((l) => l.includes("Next  : 2:34")));
  }
});

test("composeScreen: 最終ステージは MAX、それ以外は次ステージ表示", () => {
  const mk = (total) => {
    const s = stageFor(total);
    return composeScreen({
      artLines: STAGES[s.index].frames[0], bubbleText: "て", stageIndex: s.index,
      stageName: STAGES[s.index].name, total, progress: s.progress, ceil: s.ceil, pace: null,
    }).join("\n");
  };
  assert.ok(mk(6_000_000).includes("2M [")); // 下限
  assert.ok(mk(6_000_000).includes("] 10M")); // 上限
  assert.ok(mk(300_000_000).includes("200M ["));
  assert.ok(mk(300_000_000).includes("] MAX"));
});

test("composeScreen: 吹き出しとペットの中心軸が揃う", () => {
  const center = (l) => (l.match(/^ */)[0].length + strWidth(l)) / 2;
  for (const i of [0, STAGES.length - 1]) {
    const s = stageFor(THRESHOLDS[i]);
    const lines = composeScreen({
      artLines: STAGES[i].frames[0], bubbleText: "きょうも いっしょに がんばろ",
      stageIndex: s.index, stageName: STAGES[i].name,
      total: THRESHOLDS[i], progress: s.progress, ceil: s.ceil, pace: null,
    });
    const bubbleLine = lines.find((l) => l.includes("\u256d")); // ╭
    const artLines = lines.slice(BUBBLE_H, BUBBLE_H + ART_H).filter((l) => l.trim() && !/[\u256d\u2502\u2570]/.test(l));
    const widest = artLines.reduce((a, b) => (strWidth(b) >= strWidth(a) ? b : a));
    assert.ok(Math.abs(center(bubbleLine) - center(widest)) <= 2,
      `stage ${i + 1}: bubble center ${center(bubbleLine)} vs art center ${center(widest)}`);
  }
});

test("composeScreen: 吹き出しはペットの頭のすぐ上に付く", () => {
  const s = stageFor(0); // 最小ステージで確認
  const lines = composeScreen({
    artLines: STAGES[0].frames[0], bubbleText: "て", stageIndex: s.index,
    stageName: STAGES[0].name, total: 0, progress: s.progress, ceil: s.ceil, pace: null,
  });
  const bottomIdx = lines.findIndex((l) => l.includes("\u2570")); // ╰
  assert.ok(lines[bottomIdx + 1].trim(), "吹き出しの直下の行がアートである（空行を挟まない）");
});

test("parseUsageLine: モデル別コスト計算（statuslineと同じ料金表）", () => {
  const mk = (model) => JSON.stringify({
    timestamp: "2026-06-11T03:00:00.000Z", requestId: "r", message: {
      id: "m", model,
      usage: { input_tokens: 2, output_tokens: 313, cache_creation_input_tokens: 1660, cache_read_input_tokens: 31440 },
    },
  });
  // opus-4-8: 2/1e6*5 + 313/1e6*25 + 1660/1e6*6.25 + 31440/1e6*0.5
  const opus = parseUsageLine(mk("claude-opus-4-8"));
  assert.ok(Math.abs(opus.cost - 0.03393) < 1e-9, `got ${opus.cost}`);
  // fable-5: 2/1e6*10 + 313/1e6*50 + 1660/1e6*12.5 + 31440/1e6*1
  const fable = parseUsageLine(mk("claude-fable-5"));
  assert.ok(Math.abs(fable.cost - 0.06786) < 1e-9, `got ${fable.cost}`);
  // synthetic はコストゼロ
  assert.equal(parseUsageLine(mk("<synthetic>")).cost, 0);
  // 未知モデルは opus 4.5+ 料金にフォールバック（バイナリの既定値と同じ）
  assert.equal(parseUsageLine(mk("claude-unknown-99")).cost, opus.cost);
});

test("formatCost: 0.5ドル超は2桁、以下は4桁", () => {
  assert.equal(formatCost(12.345), "$12.35");
  assert.equal(formatCost(0.0076), "$0.0076");
});


test("rippleLevel: 波頭で最大レベル、未到達はnull、本家定数のグラデーション", () => {
  assert.equal(rippleLevel(50, 10), null);          // 波がまだ届かない
  assert.equal(rippleLevel(10, 10), 7);             // 波頭は最も明るい
  assert.equal(rippleLevel(0, 10), rippleLevel(20, 30)); // 波長20で周期的
  assert.deepEqual(RIPPLE_RAMP[0], [62, 22, 118]);  // 本家 vw9
  assert.deepEqual(RIPPLE_RAMP[7], [140, 80, 240]); // 本家 Mrf
});

test("formatTokensShort: 閾値の短縮表記", () => {
  assert.equal(formatTokensShort(0), "0");
  assert.equal(formatTokensShort(2_000_000), "2M");
  assert.equal(formatTokensShort(200_000_000), "200M");
});

test("STAGES: 全ステージにまばたきフレームがある（寝姿に流用するため）", () => {
  for (const [i, st] of STAGES.entries()) {
    assert.ok(st.blink, `stage ${i + 1} に blink がない`);
    assert.equal(st.blink.length, st.frames[0].length, `stage ${i + 1} の blink の行数が違う`);
  }
});

test("pickSpeech: 睡眠中は専用プール（最優先）", () => {
  const r0 = () => 0;
  const base = { stageIndex: 5, pace: 25_000_000, hour: 2, total: 0 };
  const awake = pickSpeech(base, r0);
  const asleep = pickSpeech({ ...base, asleep: true }, r0);
  assert.notEqual(awake, asleep); // 他のどの条件より優先される
  assert.equal(typeof asleep, "string");
});

test("topLineColors: 王冠の行だけ金、他は体色", () => {
  const P = { body: "B", crown: "G" };
  // Stage 6: アート10行 → artTop = BUBBLE_H + 1。王冠2行が金
  const c6 = topLineColors(10, 2, P);
  assert.equal(c6.length, BUBBLE_H + ART_H);
  const artTop = BUBBLE_H + (ART_H - 10);
  assert.equal(c6[artTop], "G");
  assert.equal(c6[artTop + 1], "G");
  assert.equal(c6[artTop + 2], "B");
  // 王冠なしステージは全部体色
  assert.ok(topLineColors(3, 0, P).every((x) => x === "B"));
});

test("SLEEP_AFTER_MS: 15分", () => {
  assert.equal(SLEEP_AFTER_MS, 15 * 60e3);
});

test("formatCountdown: mm:ss 形式、負値は 0:00", () => {
  assert.equal(formatCountdown(154_000), "2:34");
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5000), "0:00");
  assert.equal(formatCountdown(60_000), "1:00");
});

test("MIN_COLS: 実際に使う最大幅そのもの。コンテンツを足してこれが伸びたら意図的に確認する", () => {
  assert.equal(maxContentWidth(), 28);
  assert.equal(MIN_COLS, 28);
  // どのセリフの吹き出しも MIN_COLS に収まる（はみ出す行を追加したらここで気づく）
  for (const pool of Object.values(SPEECH_POOLS)) {
    for (const t of pool) {
      const w = strWidth(t) + 4;
      const right = Math.max(0, 14 - Math.floor(w / 2)) + w;
      assert.ok(right <= MIN_COLS, `セリフがはみ出す: ${t} (right=${right})`);
    }
  }
});

test("fitLines: 高さが足りなければ上部の空行を削って収める", () => {
  const lines = ["", "", "", "", "", "bubble", "art", "", "status"]; // 先頭5行が余白
  assert.equal(fitLines(lines, 20).length, 9);            // 余裕があればそのまま
  assert.equal(fitLines(lines, 7).length, 6);             // 3行削って 6+1 <= 7
  assert.equal(fitLines(lines, 5).length, 4);             // 限界まで削る（5行削って 4+1 <= 5）
  assert.equal(fitLines(lines, 4), null);                 // 空行を使い切っても入らない
  assert.equal(fitLines(["a", "b"], 2), null);            // 先頭が空行でなければ削れない
});

test("dayKey/midnightMs: 任意タイムゾーン（DST含む）", () => {
  // NY は 6月は EDT (UTC-4)
  const t = Date.parse("2026-06-12T03:00:00Z"); // NY では 6/11 23:00
  assert.equal(dayKey(t, "America/New_York"), "2026-06-11");
  assert.equal(midnightMs(t, "America/New_York"), Date.parse("2026-06-11T00:00:00-04:00"));
  // Asia/Tokyo は既存の JST 実装と一致する
  assert.equal(dayKey(t, "Asia/Tokyo"), dayKeyJST(t));
  assert.equal(midnightMs(t, "Asia/Tokyo"), jstMidnightMs(t));
});

test("resolveConfig: 環境変数 > ファイル > 既定", () => {
  const file = { language: "ja", timezone: "Asia/Tokyo", thresholds: [0, 100], intervalMinutes: 5 };
  const c1 = resolveConfig({}, file);
  assert.equal(c1.language, "ja");
  assert.equal(c1.timezone, "Asia/Tokyo");
  assert.deepEqual(c1.thresholds, [0, 100]);
  assert.equal(c1.intervalMs, 5 * 60e3);
  const c2 = resolveConfig({ CLAWD_PET_LANG: "en", CLAWD_PET_TZ: "UTC", CLAWD_PET_THRESHOLDS: "0,10,20", CLAWD_PET_INTERVAL_SEC: "10" }, file);
  assert.equal(c2.language, "en");
  assert.equal(c2.timezone, "UTC");
  assert.deepEqual(c2.thresholds, [0, 10, 20]);
  assert.equal(c2.intervalMs, 10e3);
  // ファイルなし → 既定（言語は LANG から推定、閾値は既定値）
  const c3 = resolveConfig({ LANG: "ja_JP.UTF-8" }, null);
  assert.equal(c3.language, "ja");
  assert.deepEqual(c3.thresholds, THRESHOLDS);
  // 不正な閾値（昇順でない・数値でない）は既定値に戻す
  const c4 = resolveConfig({ CLAWD_PET_THRESHOLDS: "10,0,abc" }, null);
  assert.deepEqual(c4.thresholds, THRESHOLDS);
});

test("stageFor: 閾値を引数で差し替えられる", () => {
  assert.equal(stageFor(50, [0, 10, 100]).index, 1);
  assert.equal(stageFor(50, [0, 10, 100]).ceil, 100);
});


test("TEXTS: ja/en が同じ構造を持つ", () => {
  for (const lang of ["ja", "en"]) {
    const t = TEXTS[lang];
    assert.equal(t.stageNames.length, STAGES.length);
    assert.equal(typeof t.measuring, "string");
    assert.equal(typeof t.evolved("x"), "string");
    assert.equal(typeof t.widen(48, 17, 40, 10), "string");
    for (const key of ["petted", "asleep", "legend", "night", "burning", "quiet", "generic"]) {
      assert.ok(t.pools[key].length >= 3, `${lang}.pools.${key}`);
    }
  }
});

test("pickSpeech: en プールから選べる", () => {
  const r0 = () => 0;
  const ja = pickSpeech({ stageIndex: 0, pace: null, hour: 14, total: 1e6 }, r0, "ja");
  const en = pickSpeech({ stageIndex: 0, pace: null, hour: 14, total: 1e6 }, r0, "en");
  assert.equal(ja, TEXTS.ja.pools.generic[0]);
  assert.equal(en, TEXTS.en.pools.generic[0]);
});

test("mergeLiteLLMPricing: anthropic モデルだけ取り込み、単位を per-1M に変換", () => {
  const raw = {
    "claude-test-9": {
      litellm_provider: "anthropic",
      input_cost_per_token: 0.000005,
      output_cost_per_token: 0.000025,
      cache_creation_input_token_cost: 0.00000625,
      cache_read_input_token_cost: 0.0000005,
    },
    "anthropic/claude-test-10": {
      litellm_provider: "anthropic",
      input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005,
      // cache 系なし → input から慣例比率で補完
    },
    "gpt-something": { litellm_provider: "openai", input_cost_per_token: 1, output_cost_per_token: 1 },
  };
  const merged = mergeLiteLLMPricing(PRICING, raw);
  assert.deepEqual(merged["claude-test-9"], { input: 5, output: 25, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5 });
  const t10 = merged["claude-test-10"]; // prefix が剥がれる
  assert.equal(t10.input, 10);
  assert.ok(Math.abs(t10.cacheWrite5m - 12.5) < 1e-9);  // input × 1.25
  assert.ok(Math.abs(t10.cacheRead - 1) < 1e-9);        // input × 0.1
  assert.equal(merged["gpt-something"], undefined);
  assert.ok(merged["claude-opus-4-8"]); // 既存テーブルは残る
});

test("resolveConfig: intervalSeconds が主、intervalMinutes は互換で読める", () => {
  assert.equal(resolveConfig({}, { intervalSeconds: 10 }).intervalMs, 10e3);
  assert.equal(resolveConfig({}, { intervalMinutes: 5 }).intervalMs, 5 * 60e3);
  assert.equal(resolveConfig({}, { intervalSeconds: 10, intervalMinutes: 5 }).intervalMs, 10e3); // seconds 優先
  assert.equal(resolveConfig({ CLAWD_PET_INTERVAL_SEC: "30" }, { intervalSeconds: 10 }).intervalMs, 30e3); // env 優先
  assert.equal(resolveConfig({}, { intervalSeconds: -5 }).intervalMs, DATA_INTERVAL_MS); // 不正値は既定
});

test("zzzLines: フェーズごとに z が積み上がる斜めのアニメ", () => {
  assert.equal(zzzLines(0).length, 3);
  const count = (lines, re) => lines.join("").split("").filter((c) => re.test(c)).length;
  const c0 = count(zzzLines(0), /[zZ]/);
  const c1 = count(zzzLines(1), /[zZ]/);
  const c2 = count(zzzLines(2), /[zZ]/);
  assert.ok(c0 < c1 && c1 < c2, `${c0} < ${c1} < ${c2} になっていない`);
  assert.equal(zzzLines(3 + 1).join(""), zzzLines(1).join("")); // 周期 3
});

test("composeScreen: zzzPhase 指定中は吹き出しの枠が消えて Zzz が出る", () => {
  const s = stageFor(0);
  const mk = (phase) => composeScreen({
    artLines: STAGES[0].blink, bubbleText: "すやすや… zzz", zzzPhase: phase,
    stageIndex: s.index, stageName: "clawd", total: 0,
    progress: s.progress, ceil: s.ceil, pace: null, cost: 0, nextScanInMs: 0,
  });
  const joined = mk(2).join("\n");
  assert.ok(!joined.includes("╭"), "吹き出しの枠が残っている");
  assert.ok(/[zZ]/.test(joined), "Zzz が出ていない");
  // 行数は通常時と同じ（レイアウトが崩れない）
  assert.equal(mk(0).length, BUBBLE_H + ART_H + 7);
});

test("breathArt: お腹から上が半行沈む（行数不変・隙間なし・お腹から下は不動）", () => {
  for (const [i, st] of STAGES.entries()) {
    const exhale = breathArt(st);
    assert.equal(exhale.length, st.blink.length, `stage ${i + 1}: 行数が変わった`);
    // お腹から下（bellyRow 以降）は一切変わらない
    for (let r = st.bellyRow; r < st.blink.length; r++) {
      assert.equal(exhale[r], st.blink[r], `stage ${i + 1} row ${r}: お腹より下が動いた`);
    }
    // 頭頂は沈む（インクが減るか消える）
    assert.ok(exhale[0].trim().length <= st.blink[0].trim().length, `stage ${i + 1}: 頭が沈んでいない`);
    // 隙間なし: お腹より上の中間行が空行にならない
    for (let r = 1; r < st.bellyRow; r++) {
      assert.ok(exhale[r].trim().length > 0, `stage ${i + 1} row ${r}: 隙間ができた`);
    }
  }
});
test("composeScreen: 全ステージの寝姿（呼気＋Zzz）がレイアウトを崩さない", () => {
  for (const [i, st] of STAGES.entries()) {
    for (const art of [st.blink, breathArt(st)]) {
      for (const phase of [0, 1, 2]) {
        const s = stageFor(THRESHOLDS[i]);
        const lines = composeScreen({
          artLines: art, bubbleText: "", zzzPhase: phase,
          stageIndex: s.index, stageName: "x", total: THRESHOLDS[i],
          progress: s.progress, ceil: s.ceil, pace: null, cost: 0, nextScanInMs: 0,
        });
        assert.equal(lines.length, BUBBLE_H + ART_H + 7, `stage ${i + 1}`);
        assert.ok(lines.every((l) => strWidth(l) <= MIN_COLS), `stage ${i + 1}: はみ出し`);
      }
    }
  }
});

test("--help: 使い方を表示して正常終了、未知のフラグはヘルプ＋異常終了", () => {
  const mjs = new URL("../clawd-pet.mjs", import.meta.url).pathname;
  const env = { ...process.env, CLAWD_PET_NO_FETCH: "1" };
  const help = execFileSync("node", [mjs, "--help"], { env, encoding: "utf8" });
  for (const word of ["Usage", "--once", "--preview", "--help"]) {
    assert.ok(help.includes(word), `ヘルプに ${word} がない`);
  }
  // 未知フラグ → ヘルプを出して exit 1
  let code = 0, out = "";
  try {
    execFileSync("node", [mjs, "--unknown-flag"], { env, encoding: "utf8" });
  } catch (e) {
    code = e.status;
    out = String(e.stdout);
  }
  assert.equal(code, 1);
  assert.ok(out.includes("Usage"));
});

test("MIN_ROWS: 最終形態を基準にした固定の必要高さ。全ステージがこの高さに収まる", () => {
  for (const [i, st] of STAGES.entries()) {
    const s = stageFor(THRESHOLDS[i]);
    for (const art of [st.frames[0], st.blink, breathArt(st)]) {
      const lines = composeScreen({
        artLines: art, bubbleText: "x", stageIndex: s.index, stageName: "x",
        total: THRESHOLDS[i], progress: s.progress, ceil: s.ceil, pace: null, cost: 0, nextScanInMs: 0,
      });
      // 先頭の空行を詰めれば MIN_ROWS（-1=カーソル行）に必ず収まる
      const leading = Math.max(0, lines.findIndex((l) => l !== ""));
      assert.ok(lines.length - leading + 1 <= MIN_ROWS, `stage ${i + 1} が MIN_ROWS を超える`);
    }
  }
  assert.equal(MIN_ROWS, maxContentHeight() + 1);
});

test("parseMouseEvents: SGR ホイールイベントの抽出", () => {
  // 64=ホイール上, 65=ホイール下
  const up = parseMouseEvents("\x1b[<64;10;5M");
  assert.deepEqual(up.events, ["up"]);
  const down = parseMouseEvents("\x1b[<65;10;5M");
  assert.deepEqual(down.events, ["down"]);
  // クリック(0)など非ホイールは無視
  assert.deepEqual(parseMouseEvents("\x1b[<0;3;3M\x1b[<0;3;3m").events, []);
  // 複数イベント
  assert.deepEqual(parseMouseEvents("\x1b[<64;1;1M\x1b[<65;1;1M").events, ["up", "down"]);
  // 末尾の不完全シーケンスは rest に残す
  const partial = parseMouseEvents("\x1b[<64;1;1M\x1b[<65;1");
  assert.deepEqual(partial.events, ["up"]);
  assert.ok(partial.rest.startsWith("\x1b[<65;1"));
  // 完結していれば rest は空
  assert.equal(parseMouseEvents("\x1b[<64;1;1M").rest, "");
});

test("heartLines: フェーズで ♡ が増えていく3行アニメ", () => {
  assert.equal(heartLines(0).length, 3);
  const count = (p) => heartLines(p).join("").replace(/[^♡♥]/g, "").length;
  assert.ok(count(0) < count(2), "ハートが増えていない");
  assert.equal(heartLines(3).join(""), heartLines(0).join("")); // 周期3
});

test("pickSpeech: 撫でられ中は専用プールが最優先", () => {
  const r0 = () => 0;
  const base = { stageIndex: 5, pace: 25_000_000, hour: 2, total: 0, asleep: true };
  const petted = pickSpeech({ ...base, petted: true }, r0, "ja");
  assert.equal(petted, TEXTS.ja.pools.petted[0]); // 睡眠・最終形態・深夜より優先
});

test("composeScreen: heartPhase 指定中は吹き出し枠が消えてハートが出る", () => {
  const s = stageFor(0);
  const lines = composeScreen({
    artLines: STAGES[0].blink, bubbleText: "x", heartPhase: 2,
    stageIndex: s.index, stageName: "clawd", total: 0,
    progress: s.progress, ceil: s.ceil, pace: null, cost: 0, nextScanInMs: 0,
  });
  const joined = lines.join("\n");
  assert.ok(!joined.includes("╭"), "吹き出し枠が残っている");
  assert.ok(/[♡♥]/.test(joined), "ハートが出ていない");
  assert.equal(lines.length, BUBBLE_H + ART_H + 7);
});

test("PET_DURATION_MS: 撫でられ状態の継続時間", () => {
  assert.ok(PET_DURATION_MS >= 1000);
});

test("previewSpec: 状態ごとのアニメ指定", () => {
  const now = 1000;
  for (let i = 0; i < STAGES.length; i++) {
    const idle = previewSpec(i, "idle", now);
    assert.equal(idle.zzzPhase, null);
    assert.equal(idle.heartPhase, null);
    assert.equal(idle.rippleActive, false);
    // 代表トークン量はそのステージの範囲内
    assert.ok(idle.total >= THRESHOLDS[i]);
    if (i + 1 < THRESHOLDS.length) assert.ok(idle.total < THRESHOLDS[i + 1]);

    const sleep = previewSpec(i, "sleep", now);
    assert.ok(sleep.zzzPhase !== null && sleep.sleepBody === true);

    const pet = previewSpec(i, "pet", now);
    assert.ok(pet.heartPhase !== null);
    // 撫で: 通常は目を細める(blink)、petOpen のステージは目を開けたまま(frames[0])
    assert.deepEqual(pet.art, STAGES[i].petOpen ? STAGES[i].frames[0] : STAGES[i].blink);

    const ripple = previewSpec(i, "ripple", now);
    assert.equal(ripple.rippleActive, true);
  }
});

test("PREVIEW_STATES: idle/sleep/pet/ripple の4状態", () => {
  assert.deepEqual(PREVIEW_STATES, ["idle", "sleep", "pet", "ripple"]);
});

test("breathArt: noBreath のステージは blink のまま（潰さない）", () => {
  const s1 = STAGES[0];
  assert.equal(s1.noBreath, true);
  assert.deepEqual(breathArt(s1), s1.blink);
});

test("breathArt: 王冠（crownRows）は呼吸させず固定する", () => {
  const s6 = STAGES[5];
  const breath = breathArt(s6);
  for (let r = 0; r < s6.crownRows; r++) {
    assert.equal(breath[r], s6.blink[r], `crown row ${r} が動いた`);
  }
  // 尻尾の行（最下部の本体）は途切れず残る
  assert.equal(breath[breath.length - 1], s6.blink[s6.blink.length - 1]);
});

test("Stage1: petOpen=true（撫で時は目を開ける）, Stage6: crownRows=2/bellyRow=6", () => {
  assert.equal(STAGES[0].petOpen, true);
  assert.equal(STAGES[5].crownRows, 2);
  assert.equal(STAGES[5].bellyRow, 6);
});

test("TEXTS.widen: 足りない軸ぶんだけ差分を出す", () => {
  const w = TEXTS.ja.widen;
  // 横だけ不足（必要28x22, 現在20x24）
  let m = w(28, 22, 20, 24);
  assert.ok(m.includes("横 あと8"), m);
  assert.ok(!m.includes("縦"), m);
  // 縦だけ不足
  m = w(28, 22, 30, 18);
  assert.ok(m.includes("縦 あと4"), m);
  assert.ok(!m.includes("横"), m);
  // 両方不足
  m = w(28, 22, 25, 20);
  assert.ok(m.includes("横 あと3") && m.includes("縦 あと2"), m);
  // en も同様に差分
  assert.ok(TEXTS.en.widen(28, 22, 25, 20).includes("W +3"));
});

test("browserCommand: プラットフォーム別の起動コマンド", () => {
  assert.deepEqual(browserCommand("linux", true, "http://x"), { cmd: "explorer.exe", args: ["http://x"] });
  assert.deepEqual(browserCommand("darwin", false, "http://x"), { cmd: "open", args: ["http://x"] });
  assert.deepEqual(browserCommand("win32", false, "http://x"), { cmd: "cmd", args: ["/c", "start", "", "http://x"] });
  assert.deepEqual(browserCommand("linux", false, "http://x"), { cmd: "xdg-open", args: ["http://x"] });
});

test("--edit: エディタが見つからなければ案内して exit 1", () => {
  const mjs = new URL("../clawd-pet.mjs", import.meta.url).pathname;
  // CLAWD_PET_FILE 等は使わず、存在しない場所を指すため一時ディレクトリにコピーして実行
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawd-noedit-"));
  fs.copyFileSync(mjs, path.join(tmp, "clawd-pet.mjs"));
  let code = 0, out = "";
  try {
    execFileSync("node", [path.join(tmp, "clawd-pet.mjs"), "--edit"], { encoding: "utf8", env: { ...process.env, CLAWD_PET_NO_FETCH: "1" } });
  } catch (e) { code = e.status; out = String(e.stdout); }
  assert.equal(code, 1);
  assert.ok(out.includes("clawd-web-editor"));
  fs.rmSync(tmp, { recursive: true, force: true });
});
