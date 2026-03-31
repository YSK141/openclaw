# OpenClaw Telegram Bot Handoff Plan

> **言語**: 本文は日本語。画面上に表示する文言やボタンラベルは英語（US）。詳細は `AGENTS.md` の「Documentation: plans & design」。

## 目的

OpenClaw repo 側で Telegram bot を実装するための handoff plan。  
この plan は、在庫アプリ repo にある `external-chat-link` / `external-chat-reconcile` を前提に、OpenClaw repo 側で必要な bot 実装を decision complete にまとめる。

## この plan の位置づけ

- この repo における正本
  - API 契約
  - callback data 契約
  - bot の責務
  - bot 文面
- OpenClaw repo 側で実装するもの
  - 既存 Telegram channel 上での update handling 拡張
  - 既存 bot 会話制御への reconciliation flow 追加
  - 既存 Telegram file download surface の利用
  - Supabase Edge Functions 呼び出し
  - 既存 polling / webhook / env / runtime への接続

## 実装前提

- OpenClaw には Telegram channel がすでに存在する
- 新しい独立 Telegram bot 基盤は作らない
- `extensions/telegram/src` 配下の既存 bot / polling / webhook / callback handling に機能追加する
- allowlist / pairing / routing / inline button / webhook 設定は既存 Telegram surface をそのまま使う

## v1 運用制約

- v1 は `single-active-session` 前提
- 同一 `chatId` で複数の未完了 flow は同時に扱わない
- 新しい photo を受けたら古い flow を stale 扱いにしてよい
- stale callback には restart を促す error を返す
- v1 の必須 gate は long polling
- webhook は parity check として確認するが、初期 landing bar の主経路にはしない

## design 更新

- OpenClaw 側の正本は `docs/features/telegram-external-chat-reconciliation/design.md`
- OpenClaw 側の構築手順は `docs/features/telegram-external-chat-reconciliation/setup.md`

InventoryManager 側に置かれていた OpenClaw 固有資料は、この repo 側へ移して管理する。  
この plan は OpenClaw repo 実装者向けの handoff plan であり、長期の正本は上記 docs に集約する。

## 参照ドキュメント

- `docs/features/telegram-external-chat-reconciliation/design.md`
- `docs/features/telegram-external-chat-reconciliation/setup.md`

## 実装ゴール

- Telegram で `/start` に応答できる
- link code を受けて `external-chat-link/complete` を呼べる
- 商品画像を受けて `external-chat-reconcile/search` を呼べる
- 候補選択後に `soldPrice` / `soldChannel` / `endListing` を収集できる
- `external-chat-reconcile/confirm` を呼んで完了できる

## bot の責務

- 既存 Telegram update handling の中で `link/search/select/price/channel/endlist/confirm/cancel` を解釈する
- callback data を生成・解釈する
- 既存 Telegram file download を使って画像を取得する
- `external-chat-link` / `external-chat-reconcile` を署名付きで呼ぶ
- API 結果を Telegram 向け文面に変換する

## bot が持たない責務

- 類似検索ロジック
- Inventory 更新ロジック
- eBay delist ロジック
- session 正本

これらはすべてこの repo 側 API の責務とする。

## 確定済みの API 契約

### 署名

- header
  - `x-openclaw-signature`
  - `x-openclaw-timestamp`
- secret
  - `OPENCLAW_TO_SUPABASE_SHARED_SECRET`

### link

- `POST /functions/v1/external-chat-link/complete`
- request
  - `provider: "telegram"`
  - `chatId`
  - `code`
  - `openclawAgentId?`

### search

- `POST /functions/v1/external-chat-reconcile/search`
- request
  - `provider: "telegram"`
  - `chatId`
  - `image`
- `image`
  - v1 は `base64 + mimeType + filename` を使う

### select

- `POST /functions/v1/external-chat-reconcile/select`
- request
  - `provider: "telegram"`
  - `chatId`
  - `sessionId`
  - `candidateIndex`

### confirm

- `POST /functions/v1/external-chat-reconcile/confirm`
- request
  - `provider: "telegram"`
  - `chatId`
  - `sessionId`
  - `soldPrice`
  - `soldChannel`
  - `endListing`

## callback data 契約

- Telegram `callback_data` は 64-byte 制限を超えないこと
- `sessionId` をそのまま埋め込まない
- bot 側で短い callback token を発行し、token -> session context を短命 state に保持する
- 例
  - `v1|sel|{token}|{candidateIndex}`
  - `v1|ch|{token}|store`
  - `v1|ch|{token}|flea`
  - `v1|ch|{token}|other`
  - `v1|end|{token}|yes`
  - `v1|end|{token}|no`
  - `v1|ok|{token}`
  - `v1|x|{token}`

## 実装ステップ

1. `extensions/telegram/src` 配下の既存 update / callback handling への差し込み位置を確定する
2. text / photo / callback_query から reconciliation action を判定する
3. Supabase function client を追加する
4. shared secret 署名処理を追加する
5. callback token の encode / decode と短命 state を追加する
6. link フローを実装する
7. 既存 Telegram file download surface を使って画像取得を実装する
8. search フローを実装する
9. select / price / channel / endlist / confirm フローを実装する
10. エラー文面を実装する
11. 既存 long polling で通し確認する
12. webhook は parity check として確認する

## 推奨ファイル構成

- `extensions/telegram/src/bot-handlers.ts`
  - 既存 handler 登録点への reconciliation flow 差し込み
- `extensions/telegram/src/bot-message.ts`
  - text / photo の判定が必要なら既存 message processing に接続
- `extensions/telegram/src/bot.ts`
  - callback_query handling との接続点
- `extensions/telegram/src/bot-handlers.media.ts`
  - 画像取得の既存処理を再利用できるならここを利用
- `extensions/telegram/src/<new-telegram-reconcile-module>.ts`
  - 会話オーケストレーション
- `extensions/telegram/src/<new-telegram-reconcile-callbacks-module>.ts`
  - callback token encode / parse
- `extensions/telegram/src/<new-telegram-reconcile-state-module>.ts`
  - token -> session context の短命 state
- `extensions/telegram/src/<new-telegram-reconcile-api-module>.ts`
  - `link/search/select/confirm`
- `extensions/telegram/src/<new-telegram-reconcile-messages-module>.ts`
  - 文面と inline keyboard
- 既存 `extensions/telegram/src/webhook.ts`
  - 新規 webhook 実装は不要
- 既存 `extensions/telegram/src/channel.ts`
  - 新規 channel 作成は不要

## 会話フロー

### `/start`

- Welcome 文面を返す

### link

- code テキストを受ける
- `external-chat-link/complete` を呼ぶ
- 成功時
  - `Your Telegram account is now linked.`

### search

- photo message を受ける
- 既存 Telegram file download surface から最大解像度 photo を取得する
- `external-chat-reconcile/search` を呼ぶ
- 候補なし
  - `No confident match found. Use Mark as sold in the app to continue.`
- 候補あり
  - 上位 3 件を返す

### select

- inline button で候補選択
- `external-chat-reconcile/select` を呼ぶ
- 次は `Enter sold price.`

### price

- 数値入力を受ける
- 次は `Where was this sold?`

### channel

- `Store / Flea / Other`
- `requiresEndListingChoice = true` のときだけ `End listing on eBay?`
- それ以外は confirm に進む

### confirm

- `external-chat-reconcile/confirm` を呼ぶ
- success
  - `Marked as sold.`
- partial failure
  - `Marked as sold, but ending the eBay listing failed.`

### cancel

- local state を破棄
- `Cancelled.`

## local state 方針

- bot 側で保持してよい最小 state
- `callbackToken -> sessionId`
- `chatId -> callbackToken`
  - `candidateTitle`
  - `soldPrice`
  - `soldChannel`
  - `endListing`
  - `requiresEndListingChoice`
- 正本は `external_chat_reconcile_session` にあるため、bot 側 state は短命キャッシュでよい
- callback token は Telegram callback_data 制限を守るための transport 用 state として扱う
- v1 は `chatId` ごとに 1 つの active token だけを扱う

## API レスポンス契約の前提

- request だけでなく response shape も実装前に固定する
- 少なくとも以下を明文化する
  - `search`
    - 候補配列
    - 各候補の title / subtitle / candidateIndex
    - 候補 0 件時の判定
  - `select`
    - `sessionId`
    - `candidateTitle`
    - `requiresEndListingChoice`
  - `confirm`
    - 完了結果
    - delist partial failure 判定
    - Telegram 表示用に必要な message code
- bot 側文面は freeform string 分岐ではなく、可能なら closed な response code で分ける

## 必須 UI 文面

- `Send a product photo to find a matching inventory item.`
- `Send your link code to connect this Telegram account.`
- `Your Telegram account is now linked.`
- `I found these possible matches:`
- `Select 1`
- `Select 2`
- `Select 3`
- `Enter sold price.`
- `Where was this sold?`
- `Store`
- `Flea`
- `Other`
- `End listing on eBay?`
- `Yes`
- `No`
- `Please confirm this update.`
- `Confirm`
- `Cancel`
- `Marked as sold.`
- `Marked as sold, but ending the eBay listing failed.`
- `Something went wrong. Please try again.`

## 必須環境変数

- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_FUNCTION_BASE_URL`
- `OPENCLAW_TO_SUPABASE_SHARED_SECRET`
- polling / webhook の起動は既存 Telegram config を使う
  - `channels.telegram.timeoutSeconds`
  - `channels.telegram.webhookUrl`
  - `channels.telegram.webhookSecret`
  - `channels.telegram.webhookPath`
- この機能専用の新しい polling / webhook 用 env は原則追加しない

## 手動テスト

1. `/start` に応答する
2. link code を送って link 完了する
3. 商品画像送信で候補 3 件が返る
4. 候補選択後に `Enter sold price.` が返る
5. 数値入力後に `Where was this sold?` が返る
6. eBay ACTIVE なら `End listing on eBay?` が返る
7. eBay 非 ACTIVE ならそのまま confirm に進む
8. confirm で `Marked as sold.` が返る
9. delist 失敗時に partial failure 文面が返る
10. `/cancel` で途中中断できる

## 実装完了の定義

- OpenClaw repo の既存 Telegram channel 上で flow が動作する
- この repo 側の `external-chat-link` / `external-chat-reconcile` を呼べる
- link から confirm まで手動疎通できる
- callback data と UI 文面がこの repo 側資料と一致する
- 既存 long polling で end-to-end flow が通る
- webhook path を壊さず、parity check を通せる
- 既存 Telegram config surface を逸脱しない
