-- メール（Gmail）連携。読むだけ（gmail.readonly）。リフレッシュトークンは暗号化して保存する
CREATE TABLE IF NOT EXISTS mail_accounts (
  user_id         TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  token_enc       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired')),
  connected_at    INTEGER NOT NULL,
  last_checked_at INTEGER
);

-- 1回のチェック（10:00 / 18:00 / 手動）ごとのまとめ
CREATE TABLE IF NOT EXISTS mail_digests (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  since      INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  items      TEXT NOT NULL,
  tasks      TEXT NOT NULL,
  seen_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_digests_user ON mail_digests(user_id, created_at);
