// server.mjs の純粋ヘルパのテスト（import しても listen しないこと前提）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { backupsToDelete, BACKUP_KEEP } from "./server.mjs";

test("BACKUP_KEEP: 5", () => {
  assert.equal(BACKUP_KEEP, 5);
});

test("backupsToDelete: 新しい順に keep 個を残し、古いものを返す", () => {
  const base = "clawd-pet.mjs.bak-";
  // ISO タイムスタンプ名なので辞書順 = 時系列順
  const names = [
    "clawd-pet.mjs.bak-2026-06-20T00-00-00-000Z",
    "clawd-pet.mjs.bak-2026-06-21T00-00-00-000Z",
    "clawd-pet.mjs.bak-2026-06-22T00-00-00-000Z",
    "clawd-pet.mjs.bak-2026-06-23T00-00-00-000Z",
    "clawd-pet.mjs.bak-2026-06-24T00-00-00-000Z",
    "clawd-pet.mjs.bak-2026-06-25T00-00-00-000Z",
    "clawd-pet.mjs",          // 本体は対象外
    "other.txt",              // 無関係
  ];
  const del = backupsToDelete(names, base, 5);
  // 6個中いちばん古い1個だけ削除対象
  assert.deepEqual(del, ["clawd-pet.mjs.bak-2026-06-20T00-00-00-000Z"]);
});

test("backupsToDelete: keep 以下なら何も消さない", () => {
  const base = "x.bak-";
  assert.deepEqual(backupsToDelete(["x.bak-1", "x.bak-2"], base, 5), []);
});
