-- Google カレンダー（個人のアカウント）。予定の表示・追加・変更・削除に使う。
-- リフレッシュトークンはメールと同じく AES-GCM で暗号化して保存する
CREATE TABLE IF NOT EXISTS cal_sources (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  token_enc    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired')),
  connected_at INTEGER NOT NULL
);
