# 勤怠システム

Notion「勤怠システム」の業務ルールと `mockup` のUIを元にした Web 勤怠（Python / Flask）。

## ローカル起動

```bash
cd test
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

ブラウザで http://127.0.0.1:5001/ を開く。

> macOS では AirPlay が **5000** を使うことがあるため、ローカル既定ポートは **5001** です。  
> 「アクセスが拒否されました」と出たら、5000 ではなく 5001 を開いてください。

## 初期アカウント

| 役割 | 情報 |
|------|------|
| 社員 | `1001`〜`1100`（デモデータ投入後） |
| 管理者パスワード | `7777` |
| パスワードリセットコード | `RESET-KINTAI-2026` |

### デモデータの投入

```bash
cd test
.venv/bin/python seed/import_demo.py
```

2026年4月分・社員100名（1001〜1100）の出退勤を投入します。

## Render（無料枠）へのデプロイ

1. この `test` フォルダを GitHub リポジトリに push する
2. [Render](https://render.com/) で **New → Web Service**（または Blueprint で `render.yaml`）
3. リポジトリを接続
4. 設定例
   - **Build Command:** `pip install -r requirements.txt`
   - **Start Command:** `gunicorn app:app --bind 0.0.0.0:$PORT`
5. 環境変数
   - **`DATABASE_URL`（必須）** … [Neon](https://neon.tech/) などの Postgres 接続文字列。未設定だと再デプロイでデータが消える
   - `SECRET_KEY` … ランダム文字列
   - `ADMIN_PASSWORD` … 管理者パスワード
   - `ADMIN_RESET_CODE` … リセットコード
   - `KINTAI_STRICT_SUBMIT=1` … 提出を「翌月最初の営業日のみ」に厳格化（未設定/`0` ならデモ用に毎日提出可）

手順の詳細は `DEPLOY.md` を参照。

デプロイ後の URL（例: `https://xxxx.onrender.com`）を社員に共有する。

### 無料枠の注意

- 約15分アクセスがないとスリープし、復帰に数十秒かかることがある
- **データ永続化には `DATABASE_URL`（Neon Postgres）が必須**。ローカルは SQLite のままで可

## 主な仕様

- 定時 10:00–19:00、残業は退勤の 19:00 超過分
- 出退勤は1日1回、休憩は複数回可
- 休憩法令: 労働6超〜8以下→45分 / 8超→60分（不足は画面内警告、提出は止めない）
- 提出後・承認後の修正は管理者のみ（変更履歴必須）

## ディレクトリ

```
test/
  app.py            # Flask 本体
  db.py / logic.py  # DB・業務ルール
  templates/        # 画面
  static/           # CSS / JS（mockupベース）
  requirements.txt
  Procfile / render.yaml
```
