# Flick

開いた瞬間にメモでき、フリックでステータスを動かすタスク管理 Web アプリ（iPhone 向けモバイルファースト / PWA）。

- **即メモ** — 入力欄は JS を待たずに静的 HTML で最初のペイントから使える。JS 読み込み前に打ったメモも取りこぼさない。書きかけは自動保存。
- **フリック** — 右へ払うと「未着手 → 進行中 → 完了」、左へ払うと戻る。両端（未着手の左 / 完了の右）は削除（5 秒間取り消し可）。距離が短くても速く払えば反応、ゆっくり少しだけなら元に戻る。
- **Liquid Glass（白ベース）** — Apple HIG「Materials」に沿って、ガラスは操作レイヤー（入力欄・タブ・シート・メニュー・トースト）だけに使い、カードなどのコンテンツは不透明。
- **アニメーション** — ばねで動くタブのレンズ、カードの出入り、フリック中の背面アクション、チェックの描画、件数のロール、ラージタイトルの縮小、シートの出入り/スワイプで閉じる、AI 整理中のきらめき など。
- **全画面スケルトン** — データが揃うまで画面全体をスケルトン表示（その間もメモは可能）。
- **AI（Workers AI）** — 「明日までに資料作成」→ タスク名「資料作成」+ 期限「明日」に自動整理（AI には期限の言葉と日付だけを答えさせ、タスク名は打った文から期限の言葉を取り除いて作るので、文字が書き換わらない）。詳細シートの「AIで分解」で 3〜5 個のサブタスクを生成。
- **ログインは Google のみ**。ログイン前に書いたメモはログイン後に同期。
- **オフライン** — 端末内に保存して楽観的に更新し、復帰したら同期（後勝ち）。

## 技術選定と理由

| 領域 | 採用 | 理由 |
|---|---|---|
| 実行基盤 | **Cloudflare Workers**（Static Assets 同梱） | 指定どおり Cloudflare。フロントの静的配信と API を 1 つの Worker で配信でき、同一オリジンなので CORS 不要・Cookie 認証がシンプル。エッジ配信で初回表示が速い。Pages より Workers が現在の推奨。 |
| DB | **Cloudflare D1**（SQLite） | Workers からバインディングで直接使え、ユーザー/タスクのような関係データに SQL がそのまま使える。無料枠で個人利用は十分。マイグレーションも wrangler で管理できる。 |
| AI | **Workers AI** `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 指定どおり Workers AI。JSON Mode（JSON Schema で出力形式を固定）に対応したモデルの中で日本語の理解が最も安定している 70B を選択。fp8-fast で応答も速い。失敗時はメモをそのまま残す設計。 |
| API | **Hono** | Workers 向けに作られた軽量ルーター。Cookie・ミドルウェア・型付きバインディングが揃っていて依存が小さい。 |
| 認証 | **Google OAuth 2.0（認可コード + PKCE）を自前実装** + **arctic** | Google のみなので Auth.js 等の大きな仕組みは不要。arctic は Workers で動く小さな OAuth クライアントで、PKCE/state を正しく扱える。セッションは D1 に保存（トークンはハッシュのみ保存、HttpOnly/SameSite=Lax Cookie、180 日スライディング）。 |
| フロント | **React 19 + TypeScript + Vite** | 状態が多いインタラクティブ UI に向き、エコシステム（アニメーション）が最も充実。Vite で高速ビルド。 |
| Cloudflare 連携 | **@cloudflare/vite-plugin** | 開発中も本番と同じ workerd ランタイムで Worker を動かせ、`vite build` で Worker とアセットを一緒に出力できる。 |
| アニメーション | **Motion（旧 Framer Motion）** | ばね物理、ドラッグ（フリック）とその速度、レイアウトアニメーション（タブのレンズ、リストの詰め）、出入りアニメーションを 1 つで賄える。`prefers-reduced-motion` にも自動対応。 |
| スタイル | **素の CSS（カスタムプロパティ）** | Liquid Glass は backdrop-filter・多層 box-shadow・マスクを細かく重ねるため、ユーティリティ CSS より素の CSS の方が制御しやすい。クリティカル CSS は HTML にインライン化して最初のペイントに間に合わせる。 |
| 状態管理 | **自前の小さなストア（useSyncExternalStore）+ localStorage** | 対象データが小さく、オフライン優先・楽観的更新・同期キューを自分で制御したいので、ライブラリより数十行の実装の方が明快。 |
| PWA | **手書きの Service Worker + manifest** | アプリの殻をキャッシュして 2 回目以降はネットワークを待たずに起動（stale-while-revalidate）。API はキャッシュしない。必要十分なので専用プラグインは使わない。 |
| テスト | **Playwright**（Chromium + iPhone 15 Pro エミュレーション） | 実ブラウザを自動操作して、タッチでのフリック・シートのドラッグ・オフラインなどを本番ビルド + workerd 上で検証できる。 |
| CI/CD | **GitHub Actions** | push → 型チェック → E2E 全件 → 合格時のみ Cloudflare へデプロイ（D1 作成・マイグレーション・シークレット同期まで自動）。 |

## 構成

```
index.html          静的な入力欄 + 全画面スケルトン + クリティカル CSS + ブートスクリプト
src/                React（一覧・フリック・シート・タブ・同期）
worker/             Hono API（認証 / タスク / AI）
migrations/         D1 スキーマ
e2e/                Playwright テスト
public/             manifest, Service Worker, アイコン
```

API（すべて同一オリジン、書き込みは Origin 検証あり）

| メソッド | パス | |
|---|---|---|
| GET | `/api/auth/google` → `/api/auth/google/callback` | Google ログイン |
| POST | `/api/auth/logout` | ログアウト |
| GET | `/api/me` | ログイン中のユーザー |
| GET | `/api/tasks` | タスク一覧 |
| PUT | `/api/tasks/:id` | 作成/更新（ID はクライアント生成の UUID、後勝ち） |
| DELETE | `/api/tasks/:id` | 削除（論理削除） |
| POST | `/api/ai/enrich` | メモ → タスク名 + 期限 |
| POST | `/api/ai/breakdown` | タスク → サブタスク |

## ローカルで動かす

```bash
npm install

# A) Cloudflare アカウントなしで動かす（AI はモック、ログインはテスト用）
npm run dev:mock
# → http://localhost:5173 。ブラウザの開発者ツールで次を実行するとログイン状態になる:
#   fetch('/api/auth/dev-login', { method: 'POST' }).then(() => location.reload())

# B) 本物の Google ログイン / Workers AI で動かす
npx wrangler login
cp .dev.vars.example .dev.vars   # Google のクライアント ID/シークレットを記入
npm run db:migrate:local
npm run dev
```

## テスト

```bash
npx playwright install chromium
npm test           # 本番ビルドを workerd で起動し、iPhone 15 Pro 相当の画面で全シナリオを実行
```

テスト用の環境（`CLOUDFLARE_ENV=e2e`）では AI がモックになり、テスト用ログイン `/api/auth/dev-login` が有効になります。本番の設定には含まれず、さらに localhost 以外からは 404 を返します（デプロイ後のスモークテストでも確認）。

## デプロイ（GitHub Actions → Cloudflare）

`main` に push すると、E2E が全件合格した場合だけ自動でデプロイされます。最初に一度だけ次を設定してください。

1. **Cloudflare API トークン**
   Cloudflare ダッシュボード → My Profile → API Tokens → Create Token → 「Edit Cloudflare Workers」テンプレートを選び、権限に **D1: Edit** と **Workers AI: Read** を追加して作成。
2. **Google OAuth クライアント**
   Google Cloud Console → API とサービス → 認証情報 → OAuth クライアント ID（ウェブアプリケーション）。
   承認済みのリダイレクト URI に `https://flick.<あなたのサブドメイン>.workers.dev/api/auth/google/callback` を追加（ローカル開発用に `http://localhost:5173/api/auth/google/callback` も）。
3. **GitHub リポジトリ → Settings → Secrets and variables → Actions** に登録

| Secret | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 1 のトークン |
| `CLOUDFLARE_ACCOUNT_ID` | ダッシュボード右側の Account ID |
| `CLOUDFLARE_WORKERS_SUBDOMAIN` | `xxxx.workers.dev` の `xxxx` 部分（スモークテスト用・任意） |
| `GOOGLE_CLIENT_ID` | 2 のクライアント ID |
| `GOOGLE_CLIENT_SECRET` | 2 のクライアントシークレット |

4. Actions タブ → 「Test & Deploy」→ Run workflow（または main に push）。D1 の作成・マイグレーション・デプロイ・シークレット登録まで自動で行われます。

## 既知の制約

- **iOS のキーボード**: iOS Safari はユーザー操作なしにソフトウェアキーボードを開かせない仕様のため、起動直後は入力欄を 1 回タップする必要があります（PC ではページを開いた瞬間にフォーカスが入ります）。入力欄は画面下の親指の位置に置き、JS 読み込み前から入力できるようにしてあります。
- **ガラスの屈折**: Web では本物の Liquid Glass（レンズの屈折）は再現できないため、ぼかし・彩度・スペキュラーハイライト・縁の光で近似しています。「透明度を下げる」設定時は不透明になります。
- **触覚**: iOS 18 以降は Safari のスイッチ要素の挙動を使って触覚を鳴らします（未対応環境では何も起きません）。

## デザインの参照

- Apple Human Interface Guidelines — [Materials](https://developer.apple.com/design/human-interface-guidelines/materials)（Liquid Glass はコントロール/ナビゲーション層に限定、コンテンツ層には使わない、regular バリアントで可読性を確保、控えめに使う）
