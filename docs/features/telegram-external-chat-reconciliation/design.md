# Telegram External Chat Reconciliation

## 目的

既存の OpenClaw Telegram channel 上で、外部チャットから在庫消し込みを完了できる flow を定義する。  
対象は Telegram bot 側の会話制御、callback 契約、既存 channel への統合、OpenClaw から InventoryManager 側 API を呼ぶ境界である。

## 責務分担

### OpenClaw 側の正本

- Telegram update handling
- 既存 `extensions/telegram/src` への flow 統合
- callback token / inline keyboard 契約
- Telegram file download
- bot 会話制御
- OpenClaw から InventoryManager 側 API を呼ぶ client
- OpenClaw 側の runtime / config / secrets / webhook / polling
- Telegram に表示する bot 文面

### InventoryManager 側の正本

- `external-chat-link` / `external-chat-reconcile` Edge Functions
- DB schema
- link token / binding / session の永続 state
- 類似検索ロジック
- sold 確定ロジック
- eBay delist ロジック
- app 側 `External chat` 設定導線

### 共有契約

- HTTP request / response schema
- エラー code
- callback に必要な response fields

共有契約は、server-owned な request / response schema を InventoryManager 側が保持し、Telegram UI と callback transport 契約を OpenClaw 側が保持する。

## 実装前提

- OpenClaw には Telegram channel がすでに存在する
- 新しい独立 Telegram bot 基盤は作らない
- 実装は `extensions/telegram/src` 配下の既存 bot / webhook / polling / callback handling に載せる
- allowlist / pairing / routing / inline buttons / webhook config は既存 Telegram surface を使う

## v1 運用制約

### セッション方針

- v1 は `single-active-session` とする
- 同一 `chatId` で同時に複数の reconciliation session は扱わない
- 新しい photo を受けたら、その chat にある未完了の古い flow は stale 扱いにする
- stale な callback token に対しては restart を促す error を返す

### transport / runtime 方針

- v1 の実運用 gate は long polling を優先する
- webhook は実装互換を保つが、初期 landing bar では parity check 扱いにする
- したがって v1 の必須確認は
  - polling で end-to-end flow が通ること
  - webhook で handler が壊れていないこと
- webhook 専用の新規 runtime 分岐は作らない

## ユーザーフロー

1. ユーザーが InventoryManager app で link code を発行する
2. ユーザーが Telegram bot に code を送る
3. OpenClaw が `external-chat-link/complete` を呼ぶ
4. ユーザーが Telegram bot に商品画像を送る
5. OpenClaw が画像を取得し `external-chat-reconcile/search` を呼ぶ
6. OpenClaw が候補 1-3 件を inline buttons 付きで返す
7. ユーザーが候補を選ぶ
8. OpenClaw が `external-chat-reconcile/select` を呼ぶ
9. OpenClaw が `soldPrice` を聞く
10. OpenClaw が `soldChannel` を聞く
11. 必要な場合だけ `End listing on eBay?` を聞く
12. OpenClaw が `external-chat-reconcile/confirm` を呼ぶ
13. OpenClaw が結果文面を返す

## OpenClaw 側アーキテクチャ

### 統合先

- `extensions/telegram/src/bot.ts`
- `extensions/telegram/src/bot-handlers.ts`
- `extensions/telegram/src/bot-message.ts`
- `extensions/telegram/src/bot-handlers.media.ts`
- `extensions/telegram/src/webhook.ts`

### 追加するモジュールの想定

- `extensions/telegram/src/telegram-reconcile-flow.ts`
- `extensions/telegram/src/telegram-reconcile-callbacks.ts`
- `extensions/telegram/src/telegram-reconcile-state.ts`
- `extensions/telegram/src/telegram-reconcile-api.ts`
- `extensions/telegram/src/telegram-reconcile-messages.ts`

ファイル名は実装時に調整してよいが、責務は分割する。

## API 契約

## Server contract dependency

OpenClaw 側は `external-chat-link` / `external-chat-reconcile` の server-side contract owner ではない。  
request / response / error code の canonical server contract は InventoryManager repo 側で管理する。

### Canonical owner

- canonical owner: InventoryManager repo
- canonical contract file: `supabase/functions/_shared/external-chat-contract.ts`
- business-spec owner: `docs/features/external-chat-reconciliation/design.md`

OpenClaw 側は上記 contract に従って Telegram UX を実装する。

### OpenClaw 側が正本を持つもの

- Telegram callback token 形式
- inline keyboard 構成
- Telegram 上の文面
- Telegram update handling への統合方法
- OpenClaw 側の短命 state
- OpenClaw 側の runtime / config / setup

### OpenClaw 側が正本を持たないもの

- endpoint path の意味
- request body の意味
- response body の意味
- error code の意味
- session 永続 state の意味
- sold / delist の business rule

これらは InventoryManager repo 側の canonical contract と design を正本とする。

### Change rule

InventoryManager 側 contract に変更が入る場合は、先に canonical contract を更新する。  
OpenClaw 側ではその変更に追従して Telegram UX / callback / local state を更新する。  
OpenClaw repo 側で request / response schema を独自に再定義しない。

### OpenClaw から InventoryManager へ送る request

#### link

- `POST /functions/v1/external-chat-link/complete`
- body
  - `provider: "telegram"`
  - `chatId`
  - `code`
  - `openclawAgentId?`

#### search

- `POST /functions/v1/external-chat-reconcile/search`
- body
  - `provider: "telegram"`
  - `chatId`
  - `image`
- `image`
  - `base64`
  - `mimeType`
  - `filename`

#### select

- `POST /functions/v1/external-chat-reconcile/select`
- body
  - `provider: "telegram"`
  - `chatId`
  - `sessionId`
  - `candidateIndex`

#### confirm

- `POST /functions/v1/external-chat-reconcile/confirm`
- body
  - `provider: "telegram"`
  - `chatId`
  - `sessionId`
  - `soldPrice`
  - `soldChannel`
  - `endListing`

### OpenClaw が依存する response field

response shape の正本は InventoryManager 側 canonical contract にある。  
ここでは OpenClaw 側 integration に必要な field だけを整理する。

#### search response

- `ok`
- `sessionId`
- `candidates[]`
- 各 candidate の利用 field
  - `candidateIndex`
  - `title`
  - `priceLabel?`
  - `channelLabel?`
  - `ebayStateLabel?`

#### select response

- `ok`
- `sessionId`
- `candidateTitle`
- `requiresEndListingChoice`

#### confirm response

- `ok`
- `resultCode`
  - `sold_marked`
  - `sold_marked_end_listing_failed`
- `messageCode`
  - `marked_as_sold`
  - `marked_as_sold_end_listing_failed`

#### error response

- `ok: false`
- `errorCode`
- `message?`

OpenClaw 側は freeform string を分岐条件に使わず、`errorCode` / `resultCode` / `messageCode` の closed な code を優先する。

## 署名

- header
  - `x-openclaw-signature`
  - `x-openclaw-timestamp`
- secret
  - `OPENCLAW_TO_SUPABASE_SHARED_SECRET`

## Callback 契約

- Telegram `callback_data` は 64-byte 制限を超えない
- `sessionId` をそのまま埋め込まない
- OpenClaw 側で短い callback token を発行し、短命 state で `token -> session context` を保持する

### 形式

- `v1|sel|{token}|{candidateIndex}`
- `v1|ch|{token}|store`
- `v1|ch|{token}|flea`
- `v1|ch|{token}|other`
- `v1|end|{token}|yes`
- `v1|end|{token}|no`
- `v1|ok|{token}`
- `v1|x|{token}`

## State 方針

OpenClaw 側で保持してよい state は短命キャッシュに限定する。

- `callbackToken -> sessionId`
- `chatId -> callbackToken`
- `candidateTitle`
- `soldPrice`
- `soldChannel`
- `endListing`
- `requiresEndListingChoice`

session の正本は InventoryManager 側の永続 session にあり、OpenClaw 側 state は transport 補助でしかない。

v1 では `chatId -> callbackToken` を単一 active flow の参照として使い、同一 chat の新しい flow が始まったら古い token は無効化してよい。

## UI 文面

すべて英語（US）で固定する。

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

## エラー方針

- 未連携
  - `This Telegram account is not linked. Open the app and connect External chat first.`
- session expiry
  - `This session expired. Send the photo again to restart.`
- 不正順序
  - `Please pick a candidate first.`
- 予期しないエラー
  - `Something went wrong. Please try again.`

## 設定と Secrets

- `TELEGRAM_BOT_TOKEN`
- `SUPABASE_FUNCTION_BASE_URL`
- `OPENCLAW_TO_SUPABASE_SHARED_SECRET`

この feature 専用に新しい Telegram transport 設定は増やさない。既存の Telegram config surface を使う。

- `channels.telegram.timeoutSeconds`
- `channels.telegram.webhookUrl`
- `channels.telegram.webhookSecret`
- `channels.telegram.webhookPath`

## テスト方針

- callback token encode / decode unit test
- photo message から search request 生成までの unit test
- callback query handling unit test
- `select -> price -> channel -> endlist -> confirm` の flow test
- 既存 polling と webhook の両方で手動確認

## 関連資料

- `plans/openclaw-telegram-bot-handoff.md`
- `docs/features/telegram-external-chat-reconciliation/setup.md`
