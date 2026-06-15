# clawd-pet

Claude Code の日次トークン消費量で育つターミナルペット。専用のターミナルウィンドウで飼う。

*A terminal pet that grows with your daily Claude Code token usage. English UI available — choose it in the first-run wizard.*

```
       ╭──────────────────────────────╮
       │ きょうも いっしょに がんばろ │
       ╰──────────────────────────────╯
                  ▗▄▄▄▄▄▄▄▖
                 ▟██ ███ ██▙
                ▐████████████▌
               ▗▟████████████▙▖
               ▝▜████████████▛▘
                  ▘▘▘    ▝▝▝

  Stage 4 ── はたらきもの
  Today : 47.4M tokens (47,354,582)
  30M [████████░░░░░░░░░░░░░░] 80M → Stage 5
  Cost  : $83.21
  Pace  : 14.2M tokens/h
  Next  : 2:58
```

## 特徴

- その日（タイムゾーン基準）の消費トークンで 6 段階に進化する。日付が変わると初期状態に戻る
- 進化の瞬間に紫の波紋エフェクトが走る
- 今日のコスト（USD）・消費ペース・次回更新カウントダウンを表示
- 15 分消費がないと寝る。アイドルアニメ・まばたき・一言セリフつき
- ウィンドウ上でマウスホイールを回すと撫でられて喜ぶ（ハート＋喜びセリフ）
- 依存ゼロの Node.js 単一ファイル

## 必要なもの

- Node.js 20 以上
- Claude Code（`~/.claude/projects/` にセッション記録があること）

## 使い方

```bash
git clone <このリポジトリ>
cd clawd-pet
./clawd-pet.sh
```

専用のターミナルウィンドウで起動して開いたままにする。終了は Ctrl+C または q。ウィンドウ上でホイールを回すと撫でられる。最終形態でも収まるよう、ウィンドウは **28桁 × 22行以上** にしておくと成長しても表示が崩れない。

初回起動時にウィザードが言語（日本語 / English）とタイムゾーンを聞いて、`~/.config/clawd-pet/config.json` に保存する。

### フラグ

| フラグ | 動作 |
|---|---|
| `--once` | 集計だけして 1 行出力して終了 |
| `--preview` | 対話式プレビュー（←→でステージ、↑↓で状態 idle/sleep/pet/ripple） |
| `--edit` | Web ドット絵エディタをブラウザで起動 |
| `--help` | 使い方を表示 |

## 設定

優先順位は 環境変数 > 設定ファイル > システム既定。

`~/.config/clawd-pet/config.json`:

```json
{
  "language": "ja",
  "timezone": "Asia/Tokyo",
  "thresholds": [0, 2000000, 10000000, 30000000, 80000000, 200000000],
  "intervalSeconds": 180
}
```

| 環境変数 | 意味 |
|---|---|
| `CLAWD_PET_LANG` | `ja` / `en` |
| `CLAWD_PET_TZ` | IANA タイムゾーン（例 `Asia/Tokyo`） |
| `CLAWD_PET_THRESHOLDS` | 進化閾値（カンマ区切り、昇順） |
| `CLAWD_PET_INTERVAL_SEC` | スキャン間隔（秒） |
| `CLAWD_PET_CONFIG_DIR` | 設定ディレクトリの場所 |
| `CLAWD_PET_NO_FETCH` | `1` で起動時の料金表取得を無効化 |
| `CLAUDE_CONFIG_DIR` | Claude Code の設定ディレクトリ（既定 `~/.claude`） |

進化閾値の既定値はヘビーユーザー向け（1 日 2 億トークンで最終形態）。消費量に合わせて `thresholds` を調整するといい。

## 仕組み

- `~/.claude/projects/**/*.jsonl`（Claude Code のセッション記録）から各メッセージの usage を読み、その日の合計を集計する。読み取りは追記分のみの差分スキャン
- トークン数は input + output + cache creation + cache read の合計
- コストはモデル別単価から計算する。単価は起動時に [LiteLLM の公開データ](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) から取得し、失敗時はキャッシュ → 内蔵テーブルの順でフォールバックする
- セッション記録のフォーマットは Claude Code の内部仕様であり、将来のバージョンで変わる可能性がある

## プライバシー

セッション記録はローカルで読むだけで、どこにも送信しない。ネットワークアクセスは起動時の料金表取得（GitHub 上の公開 JSON）のみで、`CLAWD_PET_NO_FETCH=1` で無効化できる。

## テスト

```bash
npm test
```
