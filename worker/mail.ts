import type { Env } from "./index";

/**
 * メール：個人（Gmail）・事業（Gmail）・大学（Outlook）の受信箱を、毎日 10:00 と 20:00（日本時間）に読み込む。
 * - どれも読むだけ（Gmail = gmail.readonly、Outlook = Microsoft Graph の Mail.Read）。送信・削除・既読の変更はしない
 * - 本文は読まず、差出人・件名・日時・冒頭の一部（Gmail の snippet / Outlook の bodyPreview）だけを使う
 * - 各枠の受信箱の新しい順に30件まで。新しく来たメールだけ AI に「何のメールか」の説明を書いてもらう
 * - 既読・未読は Flick の中だけで持つ（最初はメールサービス側の状態を使う）
 */

export type Slot = "personal" | "business" | "univ";
export const SLOTS: Slot[] = ["personal", "business", "univ"];
export const SLOT_PROVIDER: Record<Slot, "google" | "microsoft"> = { personal: "google", business: "google", univ: "microsoft" };

export type MailItem = {
  slot: Slot; id: string; from_name: string; from_addr: string; subject: string; date: number;
  snippet: string; summary: string; task_title: string | null; task_due: string | null; link: string; read: boolean;
};

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const MS_SCOPE = "offline_access User.Read Mail.Read";
const MAX_PER_SLOT = 30;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
async function decryptToken(env: Env, enc: string) {
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

async function googleAccess(env: Env, refreshToken: string) {
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

/**
 * 受信箱の新しい順に ids を取り、まだ持っていないものだけ中身（ヘッダーと冒頭）を取る。
 * 1件ずつ取ると外部通信が多くなる（無料プランは1回50まで）ので、Gmail のバッチ API でまとめて1回で取る
 */
async function fetchGmail(env: Env, access: string, email: string, known: Set<string>): Promise<{ ids: string[]; fresh: Raw[] }> {
  if (env.E2E === "1") return mockGmail(email, known);
  const list = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MAX_PER_SLOT}&labelIds=INBOX`, {
    headers: { authorization: `Bearer ${access}` },
  });
  if (list.status === 401) throw new ExpiredError("unauthorized");
  if (!list.ok) throw new Error(`gmail list ${list.status}`);
  const ids: string[] = (((await list.json()) as any).messages ?? []).map((m: any) => String(m.id));
  const need = ids.filter((id) => !known.has(id));
  if (!need.length) return { ids, fresh: [] };
  const boundary = "flick_batch";
  const q = ["From", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const body =
    need.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?format=metadata&${q}\r\n\r\n`).join("") +
    `--${boundary}--`;
  const res = await fetch("https://gmail.googleapis.com/batch/gmail/v1", {
    method: "POST",
    headers: { authorization: `Bearer ${access}`, "content-type": `multipart/mixed; boundary=${boundary}` },
    body,
  });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`gmail batch ${res.status}`);
  const fresh: Raw[] = [];
  for (const m of parseBatch(await res.text())) {
    if (!m?.id) continue;
    const h: Record<string, string> = {};
    for (const x of m.payload?.headers ?? []) h[String(x.name).toLowerCase()] = String(x.value);
    const from = parseFrom(h["from"]);
    fresh.push({
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
  return { ids, fresh };
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

/* ---------- AI：新しいメールだけ「何のメールか」の説明と、やることを付ける ---------- */

type AiOut = { mails: { i: number; summary: string; task: string | null; due_date: string | null }[] };

async function describe(env: Env, mails: Raw[], today: string): Promise<AiOut> {
  if (env.E2E === "1") return mockDescribe(mails);
  const weekday = WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()];
  const list = mails.map((m, i) => `[${i}] 差出人: ${m.from_name}\n件名: ${m.subject}\n冒頭: ${m.snippet.slice(0, 220)}`).join("\n\n");
  const raw: any = await env.AI.run(env.AI_MODEL as any, {
    messages: [
      {
        role: "system",
        content:
          `あなたは大学生の秘書です。届いたメールを、開かなくても中身がわかるように説明します。今日は ${today}（${weekday}曜日）です。\n` +
          `すべてのメールについて次を返す。\n` +
          `- i: 番号\n` +
          `- summary: 何のメールかを日本語40〜70文字で。金額・日時・締切・相手など大事な事実を入れる。固有名詞と漢字は元の文のまま使い、書いていないことは足さない。\n` +
          `- task: 本人が返信・提出・支払い・手続きなどをする必要があれば「〇〇に返信する」のような短い行動の文。必要なければ null。広告には付けない。\n` +
          `- due_date: task の締切が書いてあれば YYYY-MM-DD、なければ null。`,
      },
      { role: "user", content: list },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          mails: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, summary: { type: "string" }, task: { type: ["string", "null"] }, due_date: { type: ["string", "null"] } },
              required: ["i", "summary", "task", "due_date"],
            },
          },
        },
        required: ["mails"],
      },
    },
    max_tokens: 3000,
    temperature: 0,
  } as any);
  const r = raw?.response ?? raw;
  if (r && typeof r === "object") return r as AiOut;
  const m = typeof r === "string" ? r.match(/\{[\s\S]*\}/) : null;
  return m ? (JSON.parse(m[0]) as AiOut) : { mails: [] };
}

export function attachAi(mails: Raw[], ai: AiOut | null) {
  const byIndex = new Map((ai?.mails ?? []).map((x) => [Number(x.i), x]));
  return mails.map((m, i) => {
    const a = byIndex.get(i);
    const summary = typeof a?.summary === "string" && a.summary.trim() ? a.summary.trim().slice(0, 140) : "";
    const task = typeof a?.task === "string" && a.task.trim() ? a.task.replace(/\s+/g, " ").trim().slice(0, 200) : null;
    const due = task && typeof a?.due_date === "string" && DATE.test(a.due_date) ? a.due_date : null;
    return { ...m, summary, task_title: task, task_due: due };
  });
}

/* ---------- 1つの枠を読み込む ---------- */

const todayJST = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

export type SlotResult = "ok" | "expired" | "error";

async function refreshSlot(env: Env, userId: string, src: { slot: Slot; provider: string; email: string; token_enc: string }): Promise<SlotResult> {
  const now = Date.now();
  const { results } = await env.DB.prepare("SELECT id FROM mail_items WHERE user_id = ? AND slot = ?").bind(userId, src.slot).all<{ id: string }>();
  const known = new Set(results.map((r) => r.id));
  let fetched: { ids: string[]; fresh: Raw[] };
  try {
    const refresh = await decryptToken(env, src.token_enc);
    if (src.provider === "microsoft") {
      const t = await msAccess(env, refresh);
      if (t.refresh !== refresh) {
        await env.DB.prepare("UPDATE mail_sources SET token_enc = ? WHERE user_id = ? AND slot = ?").bind(await encryptToken(env, t.refresh), userId, src.slot).run();
      }
      fetched = await fetchOutlook(env, t.access, known);
    } else {
      fetched = await fetchGmail(env, await googleAccess(env, refresh), src.email, known);
    }
  } catch (e) {
    if (e instanceof ExpiredError || e instanceof DOMException) {
      await env.DB.prepare("UPDATE mail_sources SET status = 'expired', checked_at = ? WHERE user_id = ? AND slot = ?").bind(now, userId, src.slot).run();
      return "expired";
    }
    console.error("mail refresh failed", src.slot, e);
    return "error";
  }

  let described = attachAi(fetched.fresh, null);
  if (fetched.fresh.length) {
    try {
      described = attachAi(fetched.fresh, await describe(env, fetched.fresh, todayJST()));
    } catch (e) {
      console.warn("mail describe failed", e); // AI が失敗しても、件名と冒頭だけで表示できる
    }
  }
  const stmts = described.map((m) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO mail_items (user_id, slot, id, from_name, from_addr, subject, date, snippet, summary, task_title, task_due, link, read, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(userId, src.slot, m.id, m.from_name, m.from_addr, m.subject, m.date, m.snippet, m.summary, m.task_title, m.task_due, m.link, m.read ? 1 : 0, now),
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

/** Cron（10:00 / 20:00 JST）：つないでいる全員分 */
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

function mockGmail(email: string, known: Set<string>): { ids: string[]; fresh: Raw[] } {
  const t = Date.now() - 3 * 3_600_000;
  const biz = email.startsWith("aihp");
  const all: Raw[] = biz
    ? [{ id: "b1", from_name: "山田工務店", from_addr: "info@yamada.example.jp", subject: "ホームページ修正のお願い", date: t + 120_000, snippet: "トップページの営業時間を11月15日までに直してほしいです。", link: "https://mail.google.com/mail/u/#all/b1", read: false }]
    : [
        { id: "g1", from_name: "三井住友カード", from_addr: "info@example-card.jp", subject: "カードご利用のお知らせ", date: t + 60_000, snippet: "ご利用日 11月7日 ご利用先 Amazon ご利用金額 3,280円", link: "https://mail.google.com/mail/u/#all/g1", read: false },
        { id: "g2", from_name: "NTTデータ 採用担当", from_addr: "recruit@example.co.jp", subject: "一次面接日程のご案内", date: t + 180_000, snippet: "11月12日 10:00 からの一次面接についてご案内します。11月10日までにご返信ください。", link: "https://mail.google.com/mail/u/#all/g2", read: false },
        { id: "g3", from_name: "Amazon.co.jp", from_addr: "store-news@amazon.co.jp", subject: "タイムセール開催中", date: t, snippet: "今だけ最大50%オフ", link: "https://mail.google.com/mail/u/#all/g3", read: true },
      ];
  return { ids: all.map((m) => m.id), fresh: all.filter((m) => !known.has(m.id)) };
}

function mockOutlook(known: Set<string>): { ids: string[]; fresh: Raw[] } {
  const t = Date.now() - 2 * 3_600_000;
  const all: Raw[] = [
    { id: "u1", from_name: "東京都市大学 教務課", from_addr: "kyomu@tcu.ac.jp", subject: "【至急】履修登録の確認について", date: t + 60_000, snippet: "11月10日までに履修登録の内容を確認し、提出してください。", link: "https://outlook.office.com/mail/u1", read: false },
    { id: "u2", from_name: "キャリア支援センター", from_addr: "career@tcu.ac.jp", subject: "模擬面接のお知らせ", date: t, snippet: "11月11日に模擬面接を行います。", link: "https://outlook.office.com/mail/u2", read: true },
  ];
  return { ids: all.map((m) => m.id), fresh: all.filter((m) => !known.has(m.id)) };
}

function mockDescribe(mails: Raw[]): AiOut {
  return {
    mails: mails.map((m, i) => {
      if (/カード/.test(m.subject)) return { i, summary: "11月7日にAmazonで3,280円をカードで支払ったお知らせ", task: null, due_date: null };
      if (/面接/.test(m.subject) && /返信/.test(m.snippet)) return { i, summary: "11月12日10:00の一次面接の案内。11月10日までに返信が必要", task: "NTTデータに面接日程の返信をする", due_date: "2026-11-10" };
      if (/履修/.test(m.subject)) return { i, summary: "11月10日までに履修登録の内容を確認して提出するお願い", task: "履修登録の内容を確認して提出する", due_date: "2026-11-10" };
      if (/修正/.test(m.subject)) return { i, summary: "山田工務店から、11月15日までにトップページの営業時間を直してほしい依頼", task: "山田工務店のトップページの営業時間を直す", due_date: "2026-11-15" };
      return { i, summary: `${m.subject}のお知らせ`, task: null, due_date: null };
    }),
  };
}
