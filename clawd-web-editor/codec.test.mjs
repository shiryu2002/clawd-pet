// codec.mjs のラウンドトリップと STAGES 置換の健全性を検証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  decodeArt, encodeArt, serializeStages, findStagesRange,
  replaceStagesInSource, artToPixels, gridSizeForArts, normalizeStage,
  serializePools, normalizePools, replacePoolsInSource,
  replaceConstsInSource, SETTINGS_FIELDS, settingToDisplay, displayToSetting,
} from "./codec.mjs";
import { STAGES, THRESHOLDS, TEXTS } from "../clawd-pet.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PET_PATH = path.join(HERE, "..", "clawd-pet.mjs");

// 一時ファイルへ書いて import し、評価結果を取り出す小道具。
let counter = 0;
async function importSource(source) {
  const file = path.join(os.tmpdir(), `clawd-codec-${process.pid}-${counter++}.mjs`);
  fs.writeFileSync(file, source);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

function allArts() {
  const arts = [];
  for (const s of STAGES) {
    for (const f of s.frames) arts.push(f);
    arts.push(s.blink);
  }
  return arts;
}

test("decode→encode で本体の全アートが元に戻る", () => {
  for (const art of allArts()) {
    const { pixels } = decodeArt(art);
    assert.deepEqual(encodeArt(pixels), art);
  }
});

test("artToPixels も同じ結果を返す（共通サイズ展開）", () => {
  for (const s of STAGES) {
    const { rows, cols } = gridSizeForArts([...s.frames, s.blink]);
    for (const art of [...s.frames, s.blink]) {
      const pixels = artToPixels(art, rows, cols);
      assert.deepEqual(encodeArt(pixels), art);
    }
  }
});

test("serializeStages を import すると元の STAGES と一致する", async () => {
  const mod = await importSource(serializeStages(STAGES));
  assert.deepEqual(mod.STAGES, STAGES);
});

test("findStagesRange は STAGES 定義ちょうどを囲む", () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const { start, end } = findStagesRange(source);
  const slice = source.slice(start, end);
  assert.ok(slice.startsWith("export const STAGES = ["));
  assert.ok(slice.endsWith("];"));
  assert.ok(slice.includes('name: "でんせつのclawd"'));
});

test("replaceStagesInSource は他の export を壊さず STAGES を差し替える", async () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const replaced = replaceStagesInSource(source, STAGES);
  const mod = await importSource(replaced);
  assert.deepEqual(mod.STAGES, STAGES);
  assert.equal(mod.THRESHOLDS.length, THRESHOLDS.length);
  assert.equal(typeof mod.stageFor, "function");
});

test("編集を模した置換後も import できて新しい名前が反映される", async () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const edited = STAGES.map((s, i) => i === 0 ? { ...normalizeStage(s), name: "テスト君" } : s);
  const replaced = replaceStagesInSource(source, edited);
  const mod = await importSource(replaced);
  assert.equal(mod.STAGES[0].name, "テスト君");
  assert.deepEqual(mod.STAGES[0].frames, STAGES[0].frames);
});

test("normalizePools: 文字列配列に正規化し空行を落とす", () => {
  const out = normalizePools({ generic: ["  あ  ", "", "い"], asleep: [] });
  assert.deepEqual(out.generic, ["あ", "い"]);
  assert.deepEqual(out.asleep, []);
});

test("replacePoolsInSource: ja/en の pools を入れ替えても import でき反映される", async () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const next = replacePoolsInSource(source, {
    ja: { ...TEXTS.ja.pools, generic: ["へんしゅうした"] },
    en: { ...TEXTS.en.pools, generic: ["edited"] },
  });
  const mod = await importSource(next);
  assert.deepEqual(mod.TEXTS.ja.pools.generic, ["へんしゅうした"]);
  assert.deepEqual(mod.TEXTS.en.pools.generic, ["edited"]);
  // 他カテゴリは保持
  assert.deepEqual(mod.TEXTS.ja.pools.petted, TEXTS.ja.pools.petted);
  // STAGES や関数が壊れていない
  assert.equal(mod.STAGES.length, STAGES.length);
  assert.equal(typeof mod.pickSpeech, "function");
});

test("replacePoolsInSource: 片方の言語だけ指定しても他方は不変", async () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const next = replacePoolsInSource(source, { ja: { ...TEXTS.ja.pools, quiet: ["しずか1"] } });
  const mod = await importSource(next);
  assert.deepEqual(mod.TEXTS.ja.pools.quiet, ["しずか1"]);
  assert.deepEqual(mod.TEXTS.en.pools.quiet, TEXTS.en.pools.quiet);
});

test("settingToDisplay/displayToSetting: 単位の往復", () => {
  assert.equal(settingToDisplay("min", 900000), "15");
  assert.equal(displayToSetting("min", "15"), 900000);
  assert.equal(settingToDisplay("sec", 2500), "2.5");
  assert.equal(displayToSetting("sec", "2.5"), 2500);
  assert.equal(settingToDisplay("Mtok", [0, 2000000, 10000000]), "0, 2, 10");
  assert.deepEqual(displayToSetting("Mtok", "0, 2, 10"), [0, 2000000, 10000000]);
  assert.equal(settingToDisplay("rgb", [62, 22, 118]), "62, 22, 118");
  assert.deepEqual(displayToSetting("rgb", "62, 22, 118"), [62, 22, 118]);
  assert.equal(displayToSetting("float", "0.03"), 0.03);
});

test("replaceConstsInSource: source 定数を書き換えて import に反映", async () => {
  const source = fs.readFileSync(PET_PATH, "utf8");
  const next = replaceConstsInSource(source, {
    SLEEP_AFTER_MS: 600000,
    RIPPLE_DURATION_MS: 3000,
    RIPPLE_SPEED: 0.05,
    RIPPLE_WAVELENGTH: 16,
    RIPPLE_COLOR_FROM: [10, 20, 30],
    RIPPLE_COLOR_TO: [200, 100, 250],
  });
  const mod = await importSource(next);
  assert.equal(mod.SLEEP_AFTER_MS, 600000);
  assert.equal(mod.RIPPLE_DURATION_MS, 3000);
  assert.equal(mod.RIPPLE_SPEED, 0.05);
  assert.equal(mod.RIPPLE_WAVELENGTH, 16);
  assert.deepEqual(mod.RIPPLE_COLOR_FROM, [10, 20, 30]);
  // RIPPLE_RAMP が端点から再計算される
  assert.deepEqual(mod.RIPPLE_RAMP[0], [10, 20, 30]);
  assert.deepEqual(mod.RIPPLE_RAMP[7], [200, 100, 250]);
  // 他は壊れていない
  assert.equal(mod.STAGES.length, STAGES.length);
});

test("SETTINGS_FIELDS: source/config の target が揃っている", () => {
  for (const f of SETTINGS_FIELDS) {
    assert.ok(f.target === "source" || f.target === "config");
    if (f.target === "source") assert.ok(f.name);
    else assert.ok(f.cfgKey);
  }
});
