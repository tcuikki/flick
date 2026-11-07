import type { Env } from "./index";

/**
 * Gmail を読んで「この時間に来たメール」のまとめを作る。
 * - 読むだけ（gmail.readonly）。本文は読まず、差出人・件名・宛先・冒頭の一部（snippet）だけを使う
 * - iCloud メールは iCloud 側で Gmail へ転送してもらい、宛先（To / Delivered-To）が @icloud.com などなら「iCloud」に分ける
 * - 10:00 と 18:00（日本時間）に Cron で実行。画面の「今すぐチェック」からも実行できる
 */

export type MailKind = "action" | "check" | "info" | "ad";
export type MailItem = {
  id: string;
  threadId: string;
  source: "gmail" | "icloud";
  from: string;
  fromName: string;
  subject: string;
  date: number;
  summary: string;
  /** メールの冒頭（AI がやることを作った元の文。字化けの確認に使う） */
  snippet: string;
  kind: MailKind;
  unread: boolean;
};
export type MailTask = { title: string; due_date: string | null; status: "todo"; note: string; mailId: string };
export type Digest = { id: string; created_at: number; since: number; total: number; items: MailItem[]; tasks: MailTask[]; seen_at: number | null };

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MAX_MAILS = 35; // Workers の1回あたりの外部通信数（無料プランは50）に収まるように
const DAY = 86_400_000;
const ICLOUD = /@(icloud|me|mac)\.com\b/i;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/* ---------- リフレッシュトークンの暗号化（AES-GCM。鍵は GOOGLE_CLIENT_SECRET から導出） ---------- */

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

/* ---------- Gmail API ---------- */

class ExpiredError extends Error {}

async function accessToken(env: Env, refreshToken: string) {
  if (env.E2E === "1") {
    if (refreshToken === "expired") throw new ExpiredError("invalid_grant");
    return "e2e-access";
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (j?.error === "invalid_grant") throw new ExpiredError("invalid_grant");
    throw new Error(`token ${res.status} ${j?.error ?? ""}`);
  }
  return String(j.access_token);
}

type RawMail = { id: string; threadId: string; labelIds: string[]; snippet: string; headers: Record<string, string>; internalDate: number };

async function gmail<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (!res.ok) throw new Error(`gmail ${res.status}`);
  return res.json() as Promise<T>;
}

async function listMails(env: Env, token: string, since: number): Promise<{ mails: RawMail[]; total: number }> {
  if (env.E2E === "1") return mockMails(since);
  const q = `after:${Math.floor(since / 1000)} -in:sent -in:chats -in:drafts`;
  const list = await gmail<{ messages?: { id: string }[]; resultSizeEstimate?: number }>(
    token,
    `messages?maxResults=${MAX_MAILS}&q=${encodeURIComponent(q)}`,
  );
  const ids = (list.messages ?? []).map((m) => m.id);
  const hdr = ["From", "To", "Cc", "Delivered-To", "X-Forwarded-For", "X-Forwarded-To", "Subject", "Date"].map((h) => `metadataHeaders=${h}`).join("&");
  const mails = await Promise.all(
    ids.map(async (id) => {
      const m = await gmail<any>(token, `messages/${id}?format=metadata&${hdr}`);
      const headers: Record<string, string> = {};
      for (const h of m.payload?.headers ?? []) headers[String(h.name).toLowerCase()] = String(h.value);
      return { id: m.id, threadId: m.threadId, labelIds: m.labelIds ?? [], snippet: decodeEntities(m.snippet ?? ""), headers, internalDate: Number(m.internalDate) } as RawMail;
    }),
  );
  return { mails, total: Math.max(list.resultSizeEstimate ?? 0, mails.length) };
}

const decodeEntities = (s: string) =>
  s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export async function gmailAddress(env: Env, accessTokenValue: string) {
  if (env.E2E === "1") return "tester@gmail.com";
  const p = await gmail<{ emailAddress: string }>(accessTokenValue, "profile");
  return p.emailAddress;
}

/* ---------- 振り分けと要約 ---------- */

/** iCloud から Gmail へ転送されたメールかどうか（宛先が @icloud.com / @me.com / @mac.com） */
export function sourceOf(headers: Record<string, string>): "gmail" | "icloud" {
  const to = [headers["to"], headers["cc"], headers["delivered-to"], headers["x-forwarded-for"], headers["x-forwarded-to"]].join(" ");
  return ICLOUD.test(to) ? "icloud" : "gmail";
}

function parseFrom(v = "") {
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2], email: m[2].trim() };
  return { name: v.trim(), email: v.trim() };
}

/** 広告・SNS は Gmail のカテゴリで先に決める（AI に任せない） */
function presetKind(labels: string[]): MailKind | null {
  if (labels.some((l) => l === "CATEGORY_PROMOTIONS" || l === "CATEGORY_SOCIAL")) return "ad";
  return null;
}

type AiOut = { mails: { i: number; summary: string; kind: MailKind }[]; tasks: { i: number; title: string; due_date: string | null }[] };

async function summarize(env: Env, mails: RawMail[], today: string): Promise<AiOut> {
  if (env.E2E === "1") return mockSummarize(mails, today);
  const weekday = WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()];
  const list = mails
    .map((m, i) => `[${i}] 差出人: ${parseFrom(m.headers["from"]).name}\n件名: ${m.headers["subject"] ?? ""}\n冒頭: ${m.snippet.slice(0, 160)}`)
    .join("\n\n");
  const raw: any = await env.AI.run(env.AI_MODEL as any, {
    messages: [
      {
        role: "system",
        content:
          `あなたは大学生の秘書です。届いたメールの一覧を読み、本人が短時間で把握できるように整理します。今日は ${today}（${weekday}曜日）です。\n` +
          `- mails: すべてのメールについて、i（番号）、summary（何のメールかを日本語30文字以内で。固有名詞と漢字は元の文のまま使う）、kind を返す。\n` +
          `  kind は "action"（返信・提出・手続きなど本人の行動が必要）、"check"（予定・結果・連絡など目を通すべき）、"info"（お知らせ）、"ad"（広告・宣伝・メルマガ）。\n` +
          `- tasks: 本人の行動が必要なメールだけから、やることを作る。i（元のメールの番号）、title（「〇〇に返信する」のような短い行動の文。元の言葉と漢字をそのまま使う）、due_date（締切が書いてあれば YYYY-MM-DD、なければ null）。最大8件。`,
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
              properties: { i: { type: "integer" }, summary: { type: "string" }, kind: { type: "string", enum: ["action", "check", "info", "ad"] } },
              required: ["i", "summary", "kind"],
            },
          },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: { i: { type: "integer" }, title: { type: "string" }, due_date: { type: ["string", "null"] } },
              required: ["i", "title", "due_date"],
            },
          },
        },
        required: ["mails", "tasks"],
      },
    },
    max_tokens: 2500,
    temperature: 0,
  } as any);
  const r = raw?.response ?? raw;
  if (r && typeof r === "object") return r as AiOut;
  const m = typeof r === "string" ? r.match(/\{[\s\S]*\}/) : null;
  return m ? (JSON.parse(m[0]) as AiOut) : { mails: [], tasks: [] };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS: MailKind[] = ["action", "check", "info", "ad"];

export function buildDigest(mails: RawMail[], ai: AiOut | null): { items: MailItem[]; tasks: MailTask[] } {
  const byIndex = new Map((ai?.mails ?? []).map((x) => [Number(x.i), x]));
  const items: MailItem[] = mails.map((m, i) => {
    const from = parseFrom(m.headers["from"]);
    const a = byIndex.get(i);
    const preset = presetKind(m.labelIds);
    const kind = preset ?? (a && KINDS.includes(a.kind) ? a.kind : "info");
    return {
      id: m.id,
      threadId: m.threadId,
      source: sourceOf(m.headers),
      from: from.email,
      fromName: from.name,
      subject: (m.headers["subject"] ?? "").trim() || "（件名なし）",
      date: m.internalDate,
      summary: typeof a?.summary === "string" && a.summary.trim() ? a.summary.trim().slice(0, 80) : m.snippet.slice(0, 80),
      snippet: m.snippet.slice(0, 160),
      kind,
      unread: m.labelIds.includes("UNREAD"),
    };
  });
  const tasks: MailTask[] = [];
  for (const t of ai?.tasks ?? []) {
    const item = items[Number(t.i)];
    const title = typeof t.title === "string" ? t.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!item || !title || item.kind === "ad") continue;
    tasks.push({ title, due_date: typeof t.due_date === "string" && DATE.test(t.due_date) ? t.due_date : null, status: "todo", note: `✉ ${item.fromName}「${item.subject}」`.slice(0, 300), mailId: item.id });
    if (tasks.length >= 8) break;
  }
  // 新しい順
  items.sort((a, b) => b.date - a.date);
  return { items, tasks };
}

/* ---------- 1回のチェック ---------- */

export type CheckResult = { status: "ok"; digest: Digest } | { status: "expired" } | { status: "none" };

const todayJST = () => new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);

export async function runCheck(env: Env, userId: string): Promise<CheckResult> {
  const acc = await env.DB.prepare("SELECT token_enc, status FROM mail_accounts WHERE user_id = ?").bind(userId).first<{ token_enc: string; status: string }>();
  if (!acc) return { status: "none" };
  const last = await env.DB.prepare("SELECT MAX(created_at) AS t FROM mail_digests WHERE user_id = ?").bind(userId).first<{ t: number | null }>();
  const now = Date.now();
  // 前回のチェック以降（初回は24時間分）。最大でも3日分
  const since = Math.max(last?.t ?? now - DAY, now - 3 * DAY);
  let token: string;
  try {
    token = await accessToken(env, await decryptToken(env, acc.token_enc));
  } catch (e) {
    if (e instanceof ExpiredError || e instanceof DOMException) {
      await env.DB.prepare("UPDATE mail_accounts SET status = 'expired', last_checked_at = ? WHERE user_id = ?").bind(now, userId).run();
      return { status: "expired" };
    }
    throw e;
  }
  let fetched: { mails: RawMail[]; total: number };
  try {
    fetched = await listMails(env, token, since);
  } catch (e) {
    if (e instanceof ExpiredError) {
      await env.DB.prepare("UPDATE mail_accounts SET status = 'expired', last_checked_at = ? WHERE user_id = ?").bind(now, userId).run();
      return { status: "expired" };
    }
    throw e;
  }
  let ai: AiOut | null = null;
  if (fetched.mails.length) {
    try {
      ai = await summarize(env, fetched.mails, todayJST());
    } catch (e) {
      console.warn("mail summarize failed", e); // AI が失敗しても、件名と冒頭だけのまとめは残す
    }
  }
  const { items, tasks } = buildDigest(fetched.mails, ai);
  const digest: Digest = { id: crypto.randomUUID(), created_at: now, since, total: fetched.total, items, tasks, seen_at: null };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO mail_digests (id, user_id, created_at, since, total, items, tasks) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(digest.id, userId, now, since, digest.total, JSON.stringify(items), JSON.stringify(tasks)),
    env.DB.prepare("UPDATE mail_accounts SET status = 'ok', last_checked_at = ? WHERE user_id = ?").bind(now, userId),
    // 古いまとめは30日で消す
    env.DB.prepare("DELETE FROM mail_digests WHERE user_id = ? AND created_at < ?").bind(userId, now - 30 * DAY),
  ]);
  return { status: "ok", digest };
}

/** Cron（10:00 / 18:00 JST）：つないでいる全員分をチェック */
export async function runScheduled(env: Env) {
  const { results } = await env.DB.prepare("SELECT user_id FROM mail_accounts WHERE status = 'ok'").all<{ user_id: string }>();
  for (const r of results) {
    try {
      await runCheck(env, r.user_id);
    } catch (e) {
      console.error("mail check failed", r.user_id, e);
    }
  }
}

export function rowToDigest(r: any): Digest {
  return { id: r.id, created_at: r.created_at, since: r.since, total: r.total, items: JSON.parse(r.items), tasks: JSON.parse(r.tasks), seen_at: r.seen_at ?? null };
}

/* ---------- E2E 用のモック（本番では使われない） ---------- */

function mockMails(since: number): { mails: RawMail[]; total: number } {
  const t = Math.max(since + 60_000, Date.now() - 3 * 3_600_000);
  const mk = (i: number, from: string, to: string, subject: string, snippet: string, labels: string[]): RawMail => ({
    id: `m${i}`, threadId: `t${i}`, labelIds: labels, snippet, internalDate: t + i * 60_000,
    headers: { from, to, subject, date: new Date(t + i * 60_000).toUTCString(), "delivered-to": "tester@gmail.com" },
  });
  const mails = [
    mk(1, '"東京都市大学 教務課" <kyomu@tcu.ac.jp>', "tester@gmail.com", "【至急】履修登録の確認について", "11月10日までに履修登録の内容を確認し、提出してください。", ["INBOX", "UNREAD"]),
    mk(2, "NTTデータ 採用担当 <recruit@example.co.jp>", "tester@gmail.com", "一次面接日程のご案内", "11月12日 10:00 からの一次面接についてご案内します。", ["INBOX", "UNREAD", "CATEGORY_UPDATES"]),
    mk(3, "Amazon.co.jp <store-news@amazon.co.jp>", "tester@gmail.com", "タイムセール開催中", "今だけ最大50%オフ", ["INBOX", "CATEGORY_PROMOTIONS"]),
    mk(4, "Apple <no_reply@email.apple.com>", "ringo@icloud.com", "iCloud ストレージの領収書", "ご購入ありがとうございます。iCloud+ 50GB", ["INBOX", "UNREAD"]),
  ];
  return { mails, total: mails.length };
}

function mockSummarize(mails: RawMail[], today: string): AiOut {
  const out: AiOut = { mails: [], tasks: [] };
  mails.forEach((m, i) => {
    const s = m.headers["subject"] ?? "";
    const kind: MailKind = /至急|提出|確認/.test(s) ? "action" : /面接|日程/.test(s) ? "check" : /セール/.test(s) ? "ad" : "info";
    out.mails.push({ i, summary: `${s}のお知らせ`, kind });
    if (kind === "action") out.tasks.push({ i, title: "履修登録の内容を確認して提出する", due_date: `${today.slice(0, 4)}-11-10` });
  });
  return out;
}
