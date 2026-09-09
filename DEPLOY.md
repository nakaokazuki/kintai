# GitHub（kintai）に上げて Render で使えるまでの流れ

## 1. GitHub にリポジトリ `kintai` を作る

1. [GitHub](https://github.com/) にログインする
2. **New repository** でリポジトリ名を **`kintai`** にして作成する
3. Private / Public はどちらでも可（社内利用なら Private 推奨）
4. README や .gitignore の自動追加はしない（ローカルに既にあるため）

---

## 2. ローカルから GitHub の `kintai` に push する

ターミナルでプロジェクト直下へ移動して実行する。
GitHub リポジトリは `https://github.com/nakaokazuki/kintai` を使う。

```bash
cd "/Users/kazuki/Desktop/勤怠test/バージョン２"

# まだコミットしていない変更があれば
git add .
git commit -m "Renderデプロイ用に最新版を反映"

# リモートを追加
git remote add origin https://github.com/nakaokazuki/kintai.git

# 初回 push
git branch -M main
git push -u origin main
```

すでに `origin` がある場合は `git remote add` は不要で、`git push` だけでよい。  
URL を直したい場合:

```bash
git remote set-url origin https://github.com/nakaokazuki/kintai.git
```

---

## 3. Render で Web Service を作る

1. [Render](https://render.com/) にログインする（GitHub アカウント連携推奨）
2. **New → Web Service** を選ぶ
3. GitHub リポジトリ一覧から **`kintai`** を選ぶ
4. 設定:

| 項目 | 値 |
|------|-----|
| Name | `kintai` |
| Region | 近いもの（Singapore など） |
| Branch | `main` |
| Runtime | Python |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `gunicorn app:app --bind 0.0.0.0:$PORT` |
| Instance Type | Free |

`render.yaml` があるので、**New → Blueprint** で **`kintai`** を選ぶ方法でも同じ設定が入る。

---

## 4. 環境変数を設定する

Render の **Environment** で次を設定する（Blueprint 利用時は一部自動）。

| Key | Value（例） |
|-----|-------------|
| `SECRET_KEY` | ランダムな長い文字列（Generate 可） |
| `ADMIN_PASSWORD` | `7777`（本番なら変更推奨） |
| `ADMIN_RESET_CODE` | `RESET-KINTAI-2026` |
| `KINTAI_STRICT_SUBMIT` | `0`（デモなら毎日提出可） |
| `PYTHON_VERSION` | `3.11.9` |

---

## 5. デプロイ完了を待つ

1. **Create Web Service** / **Apply** でデプロイを開始する
2. Logs で Build successful → 起動完了を確認する
3. 画面上部の URL（例: `https://kintai.onrender.com` または `https://kintai-xxxx.onrender.com`）を開く

ここまででアプリ自体は使える。

---

## 6. デモデータを入れる（社員100名などが必要な場合）

Render の無料枠はローカルDBが永続しないことがあるため、初回や再起動後はデータ投入が必要な場合がある。

- **Shell**（プランによって利用可）で:

```bash
python seed/import_demo.py
```

- Shell が使えない場合は、ローカルで動かすか、デプロイ後に管理画面から社員を追加する運用になる。

初期ログイン情報:

- 社員番号: `1001`〜`1100`（デモ投入後）
- 管理者パスワード: `7777`（環境変数どおり）

---

## 7. 実際に使う流れ

1. ブラウザで Render の URL を開く
2. **社員**: 社員番号を入力 → 確認 → 打刻・月次一覧・提出
3. **管理者**: ナビで A-01 などを押す → パスワード入力 → ダッシュボード
4. A-05 社員管理で氏名クリック → その人の勤怠詳細（A-03）

---

## 運用上の注意（無料枠）

- 約15分アクセスがないとスリープし、復帰に数十秒かかることがある
- SQLite はインスタンス再起動で消えることがある（研修・デモ向け）
- コードを直したら `git push` するだけで Render が自動再デプロイする（Auto-Deploy が ON の場合）

---

## 最短チェックリスト

1. GitHub にリポジトリ **`kintai`** を作成
2. `git remote add origin https://github.com/nakaokazuki/kintai.git`
3. `git push -u origin main`
4. Render で **`kintai`** を選んで Web Service 作成
5. 環境変数を入れる
6. デプロイ URL を開いて動作確認
7. 必要ならデモデータ投入
