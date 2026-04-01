---
title: "Git Fork Workflow"
summary: "OpenClaw を fork 運用するときの remote、branch、復元手順の整理"
read_when:
  - OpenClaw を fork して独自運用するとき
  - upstream 同期と独自 branch の整理を見返したいとき
---

# Git Fork Workflow

このページは、OpenClaw を独自に編集しながら、公式リポジトリの更新も追従できるようにするための fork 運用メモです。

## Remote の役割

remote は 2 つ使います。

- `upstream`: 公式の `openclaw/openclaw`
- `origin`: 自分の fork

例:

```bash
git remote -v
origin   git@github.com:<your-user>/openclaw.git (fetch)
origin   git@github.com:<your-user>/openclaw.git (push)
upstream https://github.com/openclaw/openclaw.git (fetch)
upstream https://github.com/openclaw/openclaw.git (push)
```

考え方はシンプルです。

- `upstream` は公式更新を受け取る相手
- `origin` は自分の変更を push する相手

## Branch の役割

branch は役割を分けます。

- `main`: 公式 OpenClaw を追従するためのローカル branch
- `my-main`: 独自運用の本線 branch
- `feature/*`: `my-main` から切る作業 branch
- `backup-*` または `feature/restore-*`: 誤って編集した内容を救出するときの一時 branch

おすすめの構造:

```text
upstream/main
   |
   v
local main
   |
   v
origin/main

local my-main
   |
   v
origin/my-main

feature/*
   \
    -> merged into my-main
```

## 初期セットアップ

先に公式リポジトリを clone していて、その後に fork を作った場合は次の形にそろえます。

```bash
git remote rename origin upstream
git remote add origin git@github.com:<your-user>/openclaw.git
git checkout main
git push -u origin main
git checkout -b my-main
git push -u origin my-main
```

この状態にしたら:

- `main` では普段の開発をしない
- `my-main` を自分用の基準 branch にする

## 日常の作業フロー

作業するときは `my-main` から feature branch を切ります。

```bash
git checkout my-main
git pull --rebase origin my-main
git checkout -b feature/<change-name>
```

作業が終わったら `my-main` に戻します。

```bash
git checkout my-main
git merge --no-ff feature/<change-name>
git push origin my-main
```

## 公式更新の取り込み

まず `main` を公式の最新に追従させます。

```bash
git fetch upstream
git checkout main
git rebase upstream/main
git push origin main
```

そのあと `my-main` をその上に載せ直します。

```bash
git checkout my-main
git rebase main
git push origin my-main --force-with-lease
```

`my-main` を他の人と共有していて履歴を書き換えたくない場合は、`rebase` ではなく `merge` を使います。

## `main` を誤って編集したときの復元フロー

`main` を誤って編集した場合、そのまま独自変更を積み続けない方が安全です。

安全な復元手順:

1. いまの状態から recovery branch を作る
2. 変更内容を branch か patch として保存する
3. `main` を `origin/main` または `upstream/main` に戻す
4. 保存した変更を `feature/*` branch に戻す
5. その `feature/*` branch を `my-main` に取り込む

目指す状態:

- `main` は常に公式に近い状態を保つ
- `my-main` に独自変更を集約する
- recovery branch は `my-main` への取り込みが終わるまで証跡として残す

## この clone での運用メモ

この clone では、いま次の意図で branch を使っています。

- `main`: 公式追従用 branch
- `my-main`: 独自運用の本線 branch
- `feature/restore-local-work`: バックアップ patch から復元した変更を保持する branch

今後の独自変更は `main` ではなく `my-main` または `feature/*` で進める。`main` を触るのは `upstream/main` を取り込むときだけにする。
