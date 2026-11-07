-- メールを「個人 / 事業 / 大学」の3つの枠でつなげるようにする。
-- 個人・事業 = Gmail（gmail.readonly）、大学 = Outlook（Microsoft Graph の Mail.Read）。どれも読むだけ。
CREATE TABLE IF NOT EXISTS mail_sources (
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot            TEXT NOT NULL CHECK (slot IN ('personal', 'business', 'univ')),
  provider        TEXT NOT NULL CHECK (provider IN ('google', 'microsoft')),
  email           TEXT NOT NULL,
  token_enc       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired')),
  connected_at    INTEGER NOT NULL,
  checked_at      INTEGER,
  PRIMARY KEY (user_id, slot)
);

-- 受信箱の新しいメール（各枠 最新30件まで）。read は Flick の中だけの既読（メールサービス側は変えない）
CREATE TABLE IF NOT EXISTS mail_items (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slot       TEXT NOT NULL,
  id         TEXT NOT NULL,
  from_name  TEXT NOT NULL,
  from_addr  TEXT NOT NULL,
  subject    TEXT NOT NULL,
  date       INTEGER NOT NULL,
  snippet    TEXT NOT NULL,
  summary    TEXT NOT NULL DEFAULT '',
  task_title TEXT,
  task_due   TEXT,
  link       TEXT NOT NULL,
  read       INTEGER NOT NULL DEFAULT 0,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, slot, id)
);
CREATE INDEX IF NOT EXISTS idx_mail_items_user ON mail_items(user_id, slot, date);

-- 今つないでいる Gmail は「個人」に引き継ぐ
INSERT OR IGNORE INTO mail_sources (user_id, slot, provider, email, token_enc, status, connected_at, checked_at)
  SELECT user_id, 'personal', 'google', email, token_enc, status, connected_at, last_checked_at FROM mail_accounts;

DROP TABLE IF EXISTS mail_digests;
DROP TABLE IF EXISTS mail_accounts;
