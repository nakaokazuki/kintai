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

## 4. データを消さない（必須）— Neon Postgres

Render Free のディスクは再デプロイ・再起動で消えるため、**SQLite のままでは勤怠・社員データが消えます。**  
外部の無料 Postgres（[Neon](https://neon.tech/)）を使い、`DATABASE_URL` を設定してください。

### Neon で DB を作る

1. [Neon](https://console.neon.tech/) にサインアップ（GitHub 連携可）
2. **New Project** を作成（リージョンは近いもの）
3. Dashboard の **Connection string** をコピー  
   （`postgresql://...@...neon.tech/neondb?sslmode=require` の形式）

### Render に接続文字列を入れる

Render の Web Service → **Environment** に追加:

| Key | Value |
|-----|--------|
| `DATABASE_URL` | Neon の Connection string（そのまま） |

既存の環境変数も設定する（Blueprint 利用時は一部自動）。

| Key | Value（例） |
|-----|-------------|
| `SECRET_KEY` | ランダムな長い文字列（Generate 可） |
| `ADMIN_PASSWORD` | `7777`（本番なら変更推奨） |
| `ADMIN_RESET_CODE` | `RESET-KINTAI-2026` |
| `PYTHON_VERSION` | `3.11.9` |

`DATABASE_URL` を保存すると自動で再デプロイされる。  
初回だけデモ社員（1001〜1100）と 2026年4月勤怠が入る。**以降は再デプロイしても Neon 側にデータが残る。**

---

## 5. デプロイ完了を待つ

1. **Create Web Service** / **Apply** でデプロイを開始する
2. Logs で Build successful → 起動完了を確認する
3. 画面上部の URL（例: `https://kintai-e5vo.onrender.com`）を開く

---

## 6. 実際に使う流れ

1. ブラウザで Render の URL を開く
2. **社員**: 社員番号を入力 → 確認 → 打刻・月次一覧・提出
3. **管理者**: 打刻画面の「管理者」→ パスワード入力 → ダッシュボード
4. A-05 社員管理で氏名クリック → その人の勤怠詳細（A-03）

初期ログイン:

- 社員番号: `1001`〜`1100`（空の Neon に初回接続したとき自動投入）
- 管理者パスワード: `7777`（環境変数どおり）

デモを入れ直したいときだけ（既存データは消える）:

```bash
python seed/import_demo.py
```

（Render Shell が使える場合。ローカルなら `DATABASE_URL` を同じ値にして実行）

---

## 運用上の注意（無料枠）

- 約15分アクセスがないとスリープし、復帰に数十秒かかることがある
- **`DATABASE_URL`（Neon）未設定だとデータが消える** — 必ず設定する
- コードを直したら `git push` するだけで Render が自動再デプロイする（Auto-Deploy が ON の場合）

---

## 最短チェックリスト

1. GitHub にリポジトリ **`kintai`** を作成
2. `git push -u origin main`
3. Render で **`kintai`** を選んで Web Service 作成
4. **Neon で DB 作成 → `DATABASE_URL` を Render に設定**
5. デプロイ URL を開いて動作確認
