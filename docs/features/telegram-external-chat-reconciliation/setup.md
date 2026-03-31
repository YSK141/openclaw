# Telegram External Chat Reconciliation Setup

## 目的

OpenClaw repo 側で既存 Telegram channel に external chat reconciliation flow を載せ、InventoryManager 側 Edge Functions と接続するための構築手順をまとめる。

## 責務分担

### OpenClaw 側

- Telegram bot runtime
- polling / webhook 運用
- Telegram token と OpenClaw 側 secrets
- InventoryManager API 呼び出し確認

### InventoryManager 側

- `external-chat-link`
- `external-chat-reconcile`
- link code 発行
- session / binding / sold 更新

## 前提

- Node.js 22+
- OpenClaw repo の依存 install 済み
- Telegram bot token
- InventoryManager 側 Supabase project
- InventoryManager 側で `external-chat-link` / `external-chat-reconcile` が利用可能

## 必要な設定値

### OpenClaw 側

- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_FUNCTION_BASE_URL`
- `OPENCLAW_TO_SUPABASE_SHARED_SECRET`

### Telegram channel の既存設定

- `channels.telegram.timeoutSeconds`
- `channels.telegram.webhookUrl`
- `channels.telegram.webhookSecret`
- `channels.telegram.webhookPath`

この feature 専用の新しい polling / webhook 用 env は原則追加しない。

## セットアップ手順

1. InventoryManager 側で `external-chat-link` / `external-chat-reconcile` を利用可能にする
2. OpenClaw 側で `TELEGRAM_BOT_TOKEN` を設定する
3. OpenClaw 側で `SUPABASE_FUNCTION_BASE_URL` を設定する
4. OpenClaw 側で `OPENCLAW_TO_SUPABASE_SHARED_SECRET` を設定する
5. webhook 運用なら既存 `channels.telegram.webhook*` を設定する
6. OpenClaw repo で `pnpm install` を行う
7. OpenClaw repo で `pnpm check` を行う
8. OpenClaw gateway / Telegram channel を起動する
9. Telegram で `/start` を送って基本応答を確認する
10. InventoryManager app 側で link code を発行して連携確認する
11. 商品画像送信から sold confirm まで通し確認する

## 接続確認

### 1. Telegram 疎通

- `/start` に応答する

### 2. link 疎通

- app で code を発行する
- Telegram bot に code を送信する
- `Your Telegram account is now linked.` が返る

### 3. search 疎通

- 商品画像を送信する
- 候補 1-3 件が返る

### 4. confirm 疎通

- `soldPrice` を入力する
- `soldChannel` を選択する
- 必要な場合だけ `End listing on eBay?` を選択する
- `Marked as sold.` が返る

## 運用メモ

- v1 は既存 long polling を優先してもよい
- v1 の必須 gate は long polling での end-to-end 確認
- webhook は parity check 扱いでよく、初期 landing bar の主経路にはしない
- webhook を使う場合も新規 webhook 実装は不要で、既存 `extensions/telegram/src/webhook.ts` を使う
- Telegram file download は既存 Telegram 実装を再利用する
- OpenClaw 側は bot 会話制御の正本を持ち、InventoryManager 側は business logic の正本を持つ

## トラブルシュート

### `/start` に応答しない

- `TELEGRAM_BOT_TOKEN` を確認する
- Telegram channel の起動状態を確認する
- polling / webhook の既存設定を確認する

### link できない

- code の期限切れを確認する
- `external-chat-link` の利用可否を確認する
- shared secret の一致を確認する

### 画像検索できない

- `external-chat-reconcile` の利用可否を確認する
- Telegram file download の失敗を確認する
- OpenClaw から Edge Function への疎通を確認する

### confirm で失敗する

- session expiry
- `external-chat-reconcile/confirm` の response
- eBay 側の downstream failure
