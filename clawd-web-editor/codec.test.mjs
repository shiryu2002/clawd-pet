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
} from "./codec.mjs";
import { STAGES, THRESHOLDS } from "../clawd-pet.mjs";

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
