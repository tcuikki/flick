-- Gmail 側の未読（最後に見た状態）。Gmail で読んだら Flick でも既読にするために使う。
-- Flick で「未読に戻す」をしたメールは、Gmail 側の状態が変わったときだけ動かす（勝手に戻さない）
ALTER TABLE mail_items ADD COLUMN gmail_unread INTEGER;
