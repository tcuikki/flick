import type { Env } from "./index";

/**
 * メール：個人（Gmail）・事業（Gmail）・大学（受け皿の Gmail。大学の Outlook から転送）の受信箱を、
 * 5分ごと（Cron）と、画面を開いている間は1分ごと（画面から）に読み込む。
 * - どれも読むだけ（gmail.readonly）。送信・削除・既読の変更はしない
 * - 一覧には差出人・件名・日時・冒頭の一部だけを保存する。本文の全文は、タップしたときにだけ取りに行き、保存しない
 * - 各枠の受信箱の新しい順に30件まで。既読・未読は Flick の中だけで持つ
 * - 大学の Outlook を直接読む方式（Microsoft Graph）は、大学の設定でアプリ登録ができなかったため、
 *   MS_CLIENT_ID が設定されているときだけ使う
 */

export type Slot = "personal" | "business" | "univ";
export const SLOTS: Slot[] = ["personal", "business", "univ"];
export type Provider = "google" | "microsoft";
/** 大学は、Microsoft のアプリ登録があるときだけ Outlook を直接読む。ないときは受け皿の Gmail */
export const providerFor = (env: Env, slot: Slot): Provider => (slot === "univ" && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET ? "microsoft" : "google");

export type MailItem = {
  slot: Slot; id: string; from_name: string; from_addr: string; subject: string; date: number;
  snippet: string; summary: string; task_title: string | null; task_due: string | null; link: string; read: boolean;
};

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const MS_SCOPE = "offline_access User.Read Mail.Read";
const MAX_PER_SLOT = 30;
const MAX_SEARCH = 20;

/* ---------- トークンの暗号化（AES-GCM。鍵は GOOGLE_CLIENT_SECRET から導出） ---------- */

async function key(env: Env) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.GOOGLE_CLIENT_SECRET || "dev"), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("flick-mail-v1"), info: new Uint8Array() },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function encryptToken(env: Env, token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(token)));
  return `${b64(iv)}.${b64(ct)}`;
}
export async function decryptToken(env: Env, enc: string) {
  const [iv, ct] = enc.split(".");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

export class ExpiredError extends Error {}

/** 取ってきたメール（AI の説明を付ける前） */
type Raw = { id: string; from_name: string; from_addr: string; subject: string; date: number; snippet: string; link: string; read: boolean };

export function parseFrom(v = "") {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim() };
  return { name: v.trim(), email: v.trim() };
}
const decodeEntities = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/* ---------- Gmail ---------- */

export async function googleAccess(env: Env, refreshToken: string) {
  if (env.E2E === "1") {
    if (refreshToken === "expired") throw new ExpiredError("invalid_grant");
    return "e2e-access";
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j?.error === "invalid_grant") throw new ExpiredError("invalid_grant");
    throw new Error(`google token ${res.status} ${j?.error ?? ""}`);
  }
  return String(j.access_token);
}

export async function gmailAddress(env: Env, access: string) {
  if (env.E2E === "1") return "tester@gmail.com";
  const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${access}` } });
  if (!res.ok) throw new Error(`gmail profile ${res.status}`);
  return String(((await res.json()) as any).emailAddress);
}

async function gmailList(access: string, query: string, max: number): Promise<string[]> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&${query}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`gmail list ${res.status}`);
  return (((await res.json()) as any).messages ?? []).map((m: any) => String(m.id));
}

/**
 * ヘッダーと冒頭（snippet）だけを取る。1件ずつ取ると外部通信が多くなる（無料プランは1回50まで）ので、
 * Gmail のバッチ API でまとめて1回で取る
 */
async function gmailMeta(access: string, email: string, ids: string[]): Promise<Raw[]> {
  if (!ids.length) return [];
  const boundary = "flick_batch";
  const q = ["From", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const body =
    ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&${q}\r\n\r\n`).join("") +
    `--${boundary}--`;
  const res = await fetch("https://gmail.googleapis.com/batch/gmail/v1", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`gmail batch ${res.status}`);
  const out: Raw[] = [];
  for (const m of parseBatch(await res.text())) {
    if (!m?.id) continue;
    const h: Record<string, string> = {};
    for (const x of m.payload?.headers ?? []) h[String(x.name).toLowerCase()] = String(x.value);
    const from = parseFrom(h["from"]);
    out.push({
      id: String(m.id),
      from_name: from.name,
      from_addr: from.email,
      subject: (h["subject"] ?? "").trim() || "（件名なし）",
      date: Number(m.internalDate) || Date.now(),
      snippet: decodeEntities(String(m.snippet ?? "")).slice(0, 300),
      link: `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email)}#all/${m.threadId}`,
      read: !(m.labelIds ?? []).includes("UNREAD"),
    });
  }
  return out.sort((a, b) => b.date - a.date);
}

/** 受信箱の新しい順に ids を取り、まだ持っていないものだけ中身を取る */
async function fetchGmail(env: Env, access: string, email: string, known: Set<string>): Promise<{ ids: string[]; fresh: Raw[] }> {
  if (env.E2E === "1") {
    const all = mockMails(email);
    return { ids: all.map((m) => m.id), fresh: all.filter((m) => !known.has(m.id)) };
  }
  const ids = await gmailList(access, "labelIds=INBOX", MAX_PER_SLOT);
  return { ids, fresh: await gmailMeta(access, email, ids.filter((id) => !known.has(id))) };
}

/** キーワード検索（受信箱以外・古いメールも含む。Gmail の検索と同じ書き方が使える） */
async function searchGmail(env: Env, access: string, email: string, q: string): Promise<Raw[]> {
  if (env.E2E === "1") {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return mockMails(email, true)
      .filter((m) => words.every((w) => `${m.from_name} ${m.from_addr} ${m.subject} ${m.snippet}`.toLowerCase().includes(w)))
      .sort((a, b) => b.date - a.date);
  }
  return gmailMeta(access, email, await gmailList(access, `q=${encodeURIComponent(q)}`, MAX_SEARCH));
}

/**
 * 本文。日本語のメールは ISO-2022-JP や Shift_JIS のことがあり、Workers では読み替えられない文字コードがあるので、
 * 文字コードの名前とバイト列（base64）をそのまま返し、ブラウザの TextDecoder で文字にする
 */
export type BodyPart = { mime: "text/plain" | "text/html"; charset: string; data: string };

function findParts(p: any, out: { plain?: any; html?: any }) {
  if (!p) return;
  const mime = String(p.mimeType || "").toLowerCase();
  const isAttachment = Boolean(p.filename);
  if (!isAttachment && mime === "text/plain" && p.body?.data && !out.plain) out.plain = p;
  if (!isAttachment && mime === "text/html" && p.body?.data && !out.html) out.html = p;
  for (const c of p.parts ?? []) findParts(c, out);
}

const charsetOf = (p: any) => {
  const ct = (p.headers ?? []).find((h: any) => String(h.name).toLowerCase() === "content-type")?.value ?? "";
  return (String(ct).match(/charset="?([^";\s]+)/i)?.[1] ?? "utf-8").toLowerCase();
};
const b64urlToB64 = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/");

async function gmailBody(env: Env, access: string, id: string): Promise<BodyPart | null> {
  if (env.E2E === "1") return mockBody(id);
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`gmail body ${res.status}`);
  const m: any = await res.json();
  const found: { plain?: any; html?: any } = {};
  findParts(m.payload, found);
  const p = found.plain ?? found.html;
  if (!p) return null;
  return { mime: found.plain ? "text/plain" : "text/html", charset: charsetOf(p), data: b64urlToB64(String(p.body.data)).slice(0, 400_000) };
}

/** バッチ API の応答（multipart）から、各メールの JSON を取り出す */
export function parseBatch(text: string): any[] {
  const out: any[] = [];
  for (const part of text.split(/\r?\n--[^\r\n]+/)) {
    const start = part.indexOf("{");
    const end = part.lastIndexOf("}");
    if (start < 0 || end < start) continue;
    try { out.push(JSON.parse(part.slice(start, end + 1))); } catch { /* 壊れた部分は飛ばす */ }
  }
  return out;
}

/* ---------- Outlook（Microsoft Graph） ---------- */

const msBase = (env: Env) => `https://login.microsoftonline.com/${env.MS_TENANT || "organizations"}/oauth2/v2.0`;
export const msAuthorizeUrl = (env: Env) => `${msBase(env)}/authorize`;

export async function msTokenFromCode(env: Env, code: string, verifier: string, redirectUri: string) {
  const res = await fetch(`${msBase(env)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, grant_type: "authorization_code",
      code, code_verifier: verifier, redirect_uri: redirectUri, scope: MS_SCOPE,
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.refresh_token) throw new Error(`ms token ${res.status} ${j?.error ?? ""} ${j?.error_description ?? ""}`);
  return { access: String(j.access_token), refresh: String(j.refresh_token) };
}

/** Microsoft はリフレッシュするたびに新しいリフレッシュトークンをくれるので、それも返す */
async function msAccess(env: Env, refreshToken: string): Promise<{ access: string; refresh: string }> {
  if (env.E2E === "1") {
    if (refreshToken === "expired") throw new ExpiredError("invalid_grant");
    return { access: "e2e-ms", refresh: refreshToken };
  }
  const res = await fetch(`${msBase(env)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.MS_CLIENT_ID!, client_secret: env.MS_CLIENT_SECRET!, grant_type: "refresh_token", refresh_token: refreshToken, scope: MS_SCOPE }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j?.error === "invalid_grant" || j?.error === "interaction_required") throw new ExpiredError(j.error);
    throw new Error(`ms refresh ${res.status} ${j?.error ?? ""}`);
  }
  return { access: String(j.access_token), refresh: String(j.refresh_token || refreshToken) };
}

export async function msAddress(env: Env, access: string) {
  if (env.E2E === "1") return "g0000000@tcu.ac.jp";
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { authorization: `Bearer ${access}` } });
  if (!res.ok) throw new Error(`graph me ${res.status}`);
  const j: any = await res.json();
  return String(j.mail || j.userPrincipalName);
}

async function fetchOutlook(env: Env, access: string, known: Set<string>): Promise<{ ids: string[]; fresh: Raw[] }> {
  if (env.E2E === "1") return mockOutlook(known);
  const sel = "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink";
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=${MAX_PER_SLOT}&$orderby=receivedDateTime desc&$select=${sel}`,
    { headers: { authorization: `Bearer ${access}` } },
  );
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`graph messages ${res.status}`);
  const list: any[] = ((await res.json()) as any).value ?? [];
  const ids = list.map((m) => String(m.id));
  const fresh: Raw[] = list
    .filter((m) => !known.has(String(m.id)))
    .map((m) => ({
      id: String(m.id),
      from_name: String(m.from?.emailAddress?.name || m.from?.emailAddress?.address || "（差出人不明）"),
      from_addr: String(m.from?.emailAddress?.address || ""),
      subject: String(m.subject || "").trim() || "（件名なし）",
      date: Date.parse(m.receivedDateTime) || Date.now(),
      snippet: String(m.bodyPreview || "").replace(/\s+/g, " ").trim().slice(0, 300),
      link: String(m.webLink || "https://outlook.office.com/mail/"),
      read: Boolean(m.isRead),
    }));
  return { ids, fresh };
}

async function outlookBody(access: string, id: string): Promise<BodyPart | null> {
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(id)}?$select=body`, { headers: { authorization: `Bearer ${access}` } });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) return null;
  const j: any = await res.json();
  const bytes = new TextEncoder().encode(String(j.body?.content ?? "")).slice(0, 300_000);
  return { mime: j.body?.contentType === "html" ? "text/html" : "text/plain", charset: "utf-8", data: b64(bytes) };
}

async function searchOutlook(access: string, q: string): Promise<Raw[]> {
  const sel = "id,subject,from,receivedDateTime,bodyPreview,isRead,webLink";
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/messages?$search=${encodeURIComponent(`"${q.replace(/"/g, "")}"`)}&$top=${MAX_SEARCH}&$select=${sel}`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`graph search ${res.status}`);
  return (((await res.json()) as any).value ?? []).map((m: any) => ({
    id: String(m.id), from_name: String(m.from?.emailAddress?.name || ""), from_addr: String(m.from?.emailAddress?.address || ""),
    subject: String(m.subject || "（件名なし）"), date: Date.parse(m.receivedDateTime) || 0, snippet: String(m.bodyPreview || "").slice(0, 300),
    link: String(m.webLink || ""), read: Boolean(m.isRead),
  })).sort((a: Raw, b: Raw) => b.date - a.date);
}

/* ---------- 1つの枠を読み込む ---------- */

type SourceRow = { slot: Slot; provider: string; email: string; token_enc: string };

/** その枠のアクセストークン（Microsoft は新しいリフレッシュトークンも保存し直す） */
async function accessFor(env: Env, userId: string, src: SourceRow): Promise<string> {
  const refresh = await decryptToken(env, src.token_enc);
  if (src.provider === "microsoft") {
    const t = await msAccess(env, refresh);
    if (t.refresh !== refresh) {
      await env.DB.prepare("UPDATE mail_sources SET token_enc = ? WHERE user_id = ? AND slot = ?").bind(await encryptToken(env, t.refresh), userId, src.slot).run();
    }
    return t.access;
  }
  return googleAccess(env, refresh);
}

async function sourceRow(env: Env, userId: string, slot: Slot): Promise<SourceRow | null> {
  return env.DB.prepare("SELECT slot, provider, email, token_enc FROM mail_sources WHERE user_id = ? AND slot = ? AND status = 'ok'").bind(userId, slot).first<SourceRow>();
}

/** 検索（保存しない） */
export async function searchSlot(env: Env, userId: string, slot: Slot, q: string): Promise<MailItem[] | "none" | "expired"> {
  const src = await sourceRow(env, userId, slot);
  if (!src) return "none";
  try {
    const access = env.E2E === "1" ? "e2e" : await accessFor(env, userId, src);
    const raws = src.provider === "microsoft" ? await searchOutlook(access, q) : await searchGmail(env, access, src.email, q);
    // 一覧に入っているメールは、その既読・未読を使う
    const { results } = await env.DB.prepare("SELECT id, read FROM mail_items WHERE user_id = ? AND slot = ?").bind(userId, slot).all<{ id: string; read: number }>();
    const known = new Map(results.map((r) => [r.id, Boolean(r.read)]));
    return raws.map((m) => ({ ...m, slot, summary: "", task_title: null, task_due: null, read: known.get(m.id) ?? m.read }));
  } catch (e) {
    if (e instanceof ExpiredError) return "expired";
    throw e;
  }
}

/** 本文（タップしたときだけ取りに行く。保存しない） */
export async function bodyOf(env: Env, userId: string, slot: Slot, id: string): Promise<BodyPart | null | "none" | "expired"> {
  const src = await sourceRow(env, userId, slot);
  if (!src) return "none";
  try {
    const access = env.E2E === "1" ? "e2e" : await accessFor(env, userId, src);
    return src.provider === "microsoft" ? await outlookBody(access, id) : await gmailBody(env, access, id);
  } catch (e) {
    if (e instanceof ExpiredError) return "expired";
    throw e;
  }
}

export type SlotResult = "ok" | "expired" | "error";

async function refreshSlot(env: Env, userId: string, src: SourceRow): Promise<SlotResult> {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT id FROM mail_items WHERE user_id = ? AND slot = ?").bind(userId, src.slot).all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  let fetched: { ids: string[]; fresh: Raw[] };
  try {
    const access = await accessFor(env, userId, src);
    fetched = src.provider === "microsoft" ? await fetchOutlook(env, access, known) : await fetchGmail(env, access, src.email, known);
  } catch (e) {
    if (e instanceof ExpiredError || e instanceof DOMException) {
      await env.DB.prepare("UPDATE mail_sources SET status = 'expired', checked_at = ? WHERE user_id = ? AND slot = ?").bind(now, userId, src.slot).run();
      return "expired";
    }
    console.error("mail refresh failed", src.slot, e);
    return "error";
  }

  const stmts = fetched.fresh.map((m) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO mail_items (user_id, slot, id, from_name, from_addr, subject, date, snippet, link, read, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, src.slot, m.id, m.from_name, m.from_addr, m.subject, m.date, m.snippet, m.link, m.read ? 1 : 0, now),
  );
  // 受信箱から無くなったもの（アーカイブ・削除）は Flick からも消す
  const keep = fetched.ids;
  stmts.push(
    keep.length
      ? env.DB.prepare(`DELETE FROM mail_items WHERE user_id = ? AND slot = ? AND id NOT IN (${keep.map(() => "?").join(",")})`).bind(userId, src.slot, ...keep)
      : env.DB.prepare("DELETE FROM mail_items WHERE user_id = ? AND slot = ?").bind(userId, src.slot),
  );
  stmts.push(env.DB.prepare("UPDATE mail_sources SET status = 'ok', checked_at = ? WHERE user_id = ? AND slot = ?").bind(now, userId, src.slot));
  await env.DB.batch(stmts);
  return "ok";
}

/** その人のつないでいる枠を全部読み込む */
export async function refreshUser(env: Env, userId: string): Promise<Partial<Record<Slot, SlotResult>>> {
  const { results } = await env.DB.prepare("SELECT slot, provider, email, token_enc, status FROM mail_sources WHERE user_id = ?")
    .bind(userId)
    .all<{ slot: Slot; provider: string; email: string; token_enc: string; status: string }>();
  const out: Partial<Record<Slot, SlotResult>> = {};
  for (const src of results) {
    if (src.status === "expired") { out[src.slot] = "expired"; continue; }
    out[src.slot] = await refreshSlot(env, userId, src);
  }
  return out;
}

/** Cron（5分ごと）：つないでいる全員分 */
export async function runScheduled(env: Env) {
  const { results } = await env.DB.prepare("SELECT DISTINCT user_id FROM mail_sources WHERE status = 'ok'").all<{ user_id: string }>();
  for (const r of results) {
    try {
      await refreshUser(env, r.user_id);
    } catch (e) {
      console.error("mail check failed", r.user_id, e);
    }
  }
}

export const rowToItem = (r: any): MailItem => ({ ...r, read: Boolean(r.read) });

/* ---------- E2E 用のモック（本番では使われない） ---------- */

/** E2E 用：あとから届いたメール（dev-new で足す） */
const mockArrived = new Set<string>();
export const mockArrive = (email: string) => { mockArrived.add(email); };

/** メールアドレスで枠のモックを分ける（aihp… = 事業、…ukezara… = 大学の受け皿、それ以外 = 個人）。old = 受信箱にない古いメールも含める */
function mockMails(email: string, old = false): Raw[] {
  const t = Date.now() - 3 * 3_600_000;
  const day = 86_400_000;
  const mk = (id: string, from_name: string, from_addr: string, subject: string, dt: number, snippet: string, read: boolean): Raw =>
    ({ id, from_name, from_addr, subject, date: dt, snippet, link: `https://mail.google.com/mail/u/#all/${id}`, read });
  if (email.startsWith("aihp")) {
    return [mk("b1", "山田工務店", "info@yamada.example.jp", "ホームページ修正のお願い", t + 120_000, "トップページの営業時間を11月15日までに直してほしいです。", false)];
  }
  if (email.includes("ukezara")) {
    const inbox = [
      mk("u1", "東京都市大学 教務課", "kyomu@tcu.ac.jp", "【至急】履修登録の確認について", t + 60_000, "11月10日までに履修登録の内容を確認し、提出してください。", false),
      mk("u2", "キャリア支援センター", "career@tcu.ac.jp", "模擬面接のお知らせ", t, "11月11日に模擬面接を行います。", true),
    ];
    // Gmail のインポートで取り込んだ、過去の就活のメール（受信箱には出ない）
    const archived = [mk("u9", "NTTデータ 採用担当", "recruit@example.co.jp", "インターンシップ選考結果のご連絡", t - 120 * day, "先日はインターンシップ選考にご参加いただきありがとうございました。", true)];
    return old ? [...inbox, ...archived] : inbox;
  }
  const arrived = mockArrived.has(email)
    ? [mk("g4", "Google カレンダー", "calendar@example.com", "新しい予定の招待", Date.now() - 60_000, "11月20日の打ち合わせに招待されました。", false)]
    : [];
  return [
    ...arrived,
    mk("g1", "三井住友カード", "info@example-card.jp", "カードご利用のお知らせ", t + 60_000, "ご利用日 11月7日 ご利用先 Amazon ご利用金額 3,280円", false),
    mk("g2", "NTTデータ 採用担当", "recruit@example.co.jp", "一次面接日程のご案内", t + 180_000, "11月12日 10:00 からの一次面接についてご案内します。", false),
    mk("g3", "Amazon.co.jp", "store-news@amazon.co.jp", "タイムセール開催中", t, "今だけ最大50%オフ", true),
  ].sort((a, b) => b.date - a.date);
}

/** 本文のモック：g1 は日本語のメールでよくある ISO-2022-JP、g2 は HTML のメール */
function mockBody(id: string): BodyPart | null {
  if (id === "g1") {
    return {
      mime: "text/plain",
      charset: "iso-2022-jp",
      data: "GyRCOzAwZj07TSclKyE8JUkkciQ0TXhNUSQkJD8kQCQtJCIkaiQsJEgkJiQ0JDYkJCReJDkhIxsoQg0KDQobJEIkNE14TVFGfCEnGyhCMjAyNhskQkcvGyhCMTEbJEI3bhsoQjcbJEJGfBsoQg0KGyRCJDRNeE1RQGghJxsoQkFtYXpvbg0KGyRCJDRNeE1RNmIzWyEnGyhCMywyODAbJEIxXxsoQg0KDQobJEIiKEtcJWEhPCVrJE9Bdz8uQGxNUSRHJDkhIxsoQg==",
    };
  }
  if (id === "g2") {
    const html = "<html><head><style>p{color:red}</style></head><body><p>江原 様</p><p>一次面接の日程をご案内します。<br>日時：11月12日 10:00〜</p><p>ご確認のほど&nbsp;よろしくお願いいたします。</p><script>alert(1)</script></body></html>";
    return { mime: "text/html", charset: "utf-8", data: b64(new TextEncoder().encode(html)) };
  }
  return { mime: "text/plain", charset: "utf-8", data: b64(new TextEncoder().encode("本文のテストです。")) };
}

function mockOutlook(known: Set<string>): { ids: string[]; fresh: Raw[] } {
  const t = Date.now() - 2 * 3_600_000;
  const all: Raw[] = [
    { id: "u1", from_name: "東京都市大学 教務課", from_addr: "kyomu@tcu.ac.jp", subject: "【至急】履修登録の確認について", date: t + 60_000, snippet: "11月10日までに履修登録の内容を確認し、提出してください。", link: "https://outlook.office.com/mail/u1", read: false },
    { id: "u2", from_name: "キャリア支援センター", from_addr: "career@tcu.ac.jp", subject: "模擬面接のお知らせ", date: t, snippet: "11月11日に模擬面接を行います。", link: "https://outlook.office.com/mail/u2", read: true },
  ];
  return { ids: all.map((m) => m.id), fresh: all.filter((m) => !known.has(m.id)) };
}
