import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Google, generateState, generateCodeVerifier, decodeIdToken } from "arctic";
import { enrichMemo, planTasks, transcribe } from "./ai";
import {
  GMAIL_SCOPE, MS_SCOPE, SLOTS, SLOT_PROVIDER, type Slot,
  encryptToken, gmailAddress, msAddress, msAuthorizeUrl, msTokenFromCode, refreshUser, rowToItem, runScheduled,
} from "./mail";

export type Env = {
  DB: D1Database;
  AI: Ai;
  AI_MODEL: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  /** E2E テスト専用。本番では絶対に設定しない（README 参照） */
  E2E?: string;
  /** 大学（Outlook）を読むための Microsoft のアプリ登録（README 参照）。未設定なら「大学」はつなげない */
  MS_CLIENT_ID?: string;
  MS_CLIENT_SECRET?: string;
  /** 大学のテナント（例: tcu.ac.jp） */
  MS_TENANT?: string;
};

type User = { id: string; email: string; name: string; picture: string };
type App = { Bindings: Env; Variables: { user: User } };

const SESSION_COOKIE = "flick_sid";
const SESSION_DAYS = 180;
const DAY = 86_400_000;
const STATUSES = ["todo", "doing", "done"] as const;

const app = new Hono<App>().basePath("/api");

/* ---------- 共通ユーティリティ ---------- */

const isHttps = (url: string) => new URL(url).protocol === "https:";

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function google(c: { env: Env; req: { url: string } }) {
  const origin = new URL(c.req.url).origin;
  return new Google(c.env.GOOGLE_CLIENT_ID, c.env.GOOGLE_CLIENT_SECRET, `${origin}/api/auth/google/callback`);
}

async function createSession(c: any, userId: string) {
  const token = randomToken();
  const expires = Date.now() + SESSION_DAYS * DAY;
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, expires)
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c.req.url),
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86_400,
  });
}

async function upsertUser(db: D1Database, u: User) {
  await db
    .prepare(
      `INSERT INTO users (id, email, name, picture, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`,
    )
    .bind(u.id, u.email, u.name, u.picture, Date.now())
    .run();
}

/* ---------- セキュリティ: 書き込み系は同一オリジンのみ ---------- */

app.use("*", async (c, next) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const origin = c.req.header("origin");
    if (!origin || origin !== new URL(c.req.url).origin) {
      return c.json({ error: "forbidden_origin" }, 403);
    }
  }
  await next();
  c.header("Cache-Control", "no-store");
});

app.get("/health", (c) => c.json({ ok: true }));

/* ---------- 認証: Google OAuth 2.0 (Authorization Code + PKCE) ---------- */

app.get("/auth/google", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID || !c.env.GOOGLE_CLIENT_SECRET) {
    return c.json({ error: "google_oauth_not_configured" }, 500);
  }
  const state = generateState();
  const verifier = generateCodeVerifier();
  const url = google(c).createAuthorizationURL(state, verifier, ["openid", "email", "profile"]);
  url.searchParams.set("prompt", "select_account");
  const opts = { httpOnly: true, secure: isHttps(c.req.url), sameSite: "Lax" as const, path: "/", maxAge: 600 };
  setCookie(c, "flick_oauth_state", state, opts);
  setCookie(c, "flick_oauth_verifier", verifier, opts);
  return c.redirect(url.toString(), 302);
});

/** セッション Cookie からログイン中のユーザーを調べる（ログイン必須の範囲の外で使う） */
async function sessionUserId(c: any): Promise<string | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const row = await c.env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE id = ?")
    .bind(await sha256(token))
    .first();
  return row && row.expires_at > Date.now() ? String(row.user_id) : null;
}

async function saveSource(c: any, userId: string, slot: Slot, email: string, refresh: string) {
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO mail_sources (user_id, slot, provider, email, token_enc, status, connected_at) VALUES (?, ?, ?, ?, ?, 'ok', ?)
       ON CONFLICT(user_id, slot) DO UPDATE SET provider = excluded.provider, email = excluded.email, token_enc = excluded.token_enc, status = 'ok', connected_at = excluded.connected_at`,
    ).bind(userId, slot, SLOT_PROVIDER[slot], email, await encryptToken(c.env, refresh), Date.now()),
    // 別のアカウントにつなぎ直したときに前のメールが混ざらないように
    c.env.DB.prepare("DELETE FROM mail_items WHERE user_id = ? AND slot = ?").bind(userId, slot),
  ]);
  // つないだらすぐ読み込む（失敗しても次の 10:00 / 20:00 に読む）
  c.executionCtx.waitUntil(refreshUser(c.env, userId).catch((e: unknown) => console.warn("first refresh failed", e)));
}

/** Gmail（読むだけ）の許可を受け取り、リフレッシュトークンを暗号化して保存する */
async function connectGmail(c: any, slot: Slot, code: string, verifier: string) {
  const userId = await sessionUserId(c);
  if (!userId) return c.redirect("/?mail=failed", 302);
  try {
    const tokens = await google(c).validateAuthorizationCode(code, verifier);
    const scopes: string[] = tokens.hasScopes() ? tokens.scopes() : [];
    if (!scopes.includes(GMAIL_SCOPE) || !tokens.hasRefreshToken()) return c.redirect("/?mail=denied", 302);
    const email = await gmailAddress(c.env, tokens.accessToken());
    await saveSource(c, userId, slot, email, tokens.refreshToken());
    return c.redirect(`/?mail=connected&slot=${slot}`, 302);
  } catch (e) {
    console.warn("gmail connect failed", e);
    return c.redirect("/?mail=failed", 302);
  }
}

app.get("/auth/google/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, "flick_oauth_state");
  const verifier = getCookie(c, "flick_oauth_verifier");
  deleteCookie(c, "flick_oauth_state", { path: "/" });
  deleteCookie(c, "flick_oauth_verifier", { path: "/" });
  const purpose = getCookie(c, "flick_oauth_purpose");
  deleteCookie(c, "flick_oauth_purpose", { path: "/" });
  if (!code || !state || !savedState || !verifier || state !== savedState) {
    return c.redirect(purpose?.startsWith("mail-") ? "/?mail=failed" : "/?login=failed", 302);
  }
  if (purpose === "mail-personal" || purpose === "mail-business") return connectGmail(c, purpose.slice(5) as Slot, code, verifier);
  try {
    const tokens = await google(c).validateAuthorizationCode(code, verifier);
    // ID トークンは Google のトークンエンドポイントから TLS で直接受け取っているので署名検証は不要（OIDC Core 3.1.3.7）
    const claims = decodeIdToken(tokens.idToken()) as Record<string, any>;
    if (!claims.sub || !claims.email || claims.email_verified === false) {
      return c.redirect("/?login=failed", 302);
    }
    const user: User = {
      id: `google:${claims.sub}`,
      email: String(claims.email),
      name: String(claims.name ?? ""),
      picture: String(claims.picture ?? ""),
    };
    await upsertUser(c.env.DB, user);
    await createSession(c, user.id);
    return c.redirect("/", 302);
  } catch {
    return c.redirect("/?login=failed", 302);
  }
});

/** E2E テスト専用のログイン。E2E=1 のときだけ存在する */
app.post("/auth/dev-login", async (c) => {
  // 二重の安全策: E2E フラグがあり、かつ localhost からのアクセスのときだけ
  if (c.env.E2E !== "1" || !["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname)) return c.notFound();
  const body = await c.req.json<{ email?: string; name?: string }>().catch(() => ({}) as any);
  const email = String(body.email || "tester@example.com");
  const user: User = { id: `dev:${email}`, email, name: String(body.name || "Tester"), picture: "" };
  await upsertUser(c.env.DB, user);
  await createSession(c, user.id);
  return c.json({ ok: true });
});

app.post("/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256(token)).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

/* ---------- 大学（Outlook）：Microsoft の OAuth 2.0（Authorization Code + PKCE） ---------- */

const msRedirect = (c: any) => `${new URL(c.req.url).origin}/api/auth/microsoft/callback`;

app.get("/auth/microsoft/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const savedState = getCookie(c, "flick_ms_state");
  const verifier = getCookie(c, "flick_ms_verifier");
  deleteCookie(c, "flick_ms_state", { path: "/" });
  deleteCookie(c, "flick_ms_verifier", { path: "/" });
  const err = `${c.req.query("error") ?? ""} ${c.req.query("error_description") ?? ""}`;
  // 大学の設定で「管理者の承認が必要」なとき（AADSTS65001 / 90094 / 90095 など）
  if (/AADSTS(65001|90094|90095|900941)|admin|consent_required/i.test(err)) return c.redirect("/?mail=ms-admin", 302);
  if (!code || !state || !savedState || !verifier || state !== savedState) return c.redirect("/?mail=failed", 302);
  const userId = await sessionUserId(c);
  if (!userId) return c.redirect("/?mail=failed", 302);
  try {
    const t = await msTokenFromCode(c.env, code, verifier, msRedirect(c));
    const email = await msAddress(c.env, t.access);
    await saveSource(c, userId, "univ", email, t.refresh);
    return c.redirect("/?mail=connected&slot=univ", 302);
  } catch (e) {
    console.warn("outlook connect failed", e);
    return c.redirect("/?mail=failed", 302);
  }
});

/* ---------- ここから先はログイン必須 ---------- */

app.use("/*", async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const id = await sha256(token);
  const row = await c.env.DB.prepare(
    `SELECT s.expires_at, u.id, u.email, u.name, u.picture
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
  )
    .bind(id)
    .first<User & { expires_at: number }>();
  if (!row || row.expires_at < Date.now()) {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ error: "unauthorized" }, 401);
  }
  // 期限の半分を切ったら延長（スライディングセッション）
  if (row.expires_at - Date.now() < (SESSION_DAYS / 2) * DAY) {
    const expires = Date.now() + SESSION_DAYS * DAY;
    await c.env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").bind(expires, id).run();
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true, secure: isHttps(c.req.url), sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86_400,
    });
  }
  c.set("user", { id: row.id, email: row.email, name: row.name, picture: row.picture });
  await next();
});

app.get("/me", (c) => c.json({ user: c.get("user") }));

/* ---------- タスク ---------- */

type TaskRow = {
  id: string; title: string; note: string; status: (typeof STATUSES)[number];
  due_date: string | null; sort: number; created_at: number; updated_at: number;
};

const COLUMNS = "id, title, note, status, due_date, sort, created_at, updated_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

app.get("/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${COLUMNS} FROM tasks WHERE user_id = ? AND deleted_at IS NULL ORDER BY sort DESC, created_at DESC`,
  )
    .bind(c.get("user").id)
    .all<TaskRow>();
  return c.json({ tasks: results });
});

app.put("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  if (!UUID.test(id)) return c.json({ error: "invalid_id" }, 400);
  const b = await c.req.json<Partial<TaskRow>>().catch(() => null);
  if (!b) return c.json({ error: "invalid_json" }, 400);
  const title = String(b.title ?? "").trim().slice(0, 500);
  const note = String(b.note ?? "").slice(0, 5000);
  const status = STATUSES.includes(b.status as any) ? b.status! : "todo";
  const due = b.due_date && DATE.test(b.due_date) ? b.due_date : null;
  const now = Date.now();
  const created = Number.isFinite(b.created_at) ? Math.min(Number(b.created_at), now) : now;
  const updated = Number.isFinite(b.updated_at) ? Math.min(Number(b.updated_at), now) : now;
  const sort = Number.isFinite(b.sort) ? Number(b.sort) : created;
  if (!title) return c.json({ error: "title_required" }, 400);

  // 後勝ち (Last-Write-Wins)。他人のタスク ID は上書きできない
  await c.env.DB.prepare(
    `INSERT INTO tasks (id, user_id, title, note, status, due_date, sort, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title, note = excluded.note, status = excluded.status,
       due_date = excluded.due_date, sort = excluded.sort, updated_at = excluded.updated_at
     WHERE tasks.user_id = excluded.user_id AND tasks.deleted_at IS NULL
       AND excluded.updated_at >= tasks.updated_at`,
  )
    .bind(id, c.get("user").id, title, note, status, due, sort, created, updated)
    .run();
  const row = await c.env.DB.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .bind(id, c.get("user").id)
    .first<TaskRow>();
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json({ task: row });
});

app.delete("/tasks/:id", async (c) => {
  const now = Date.now();
  await c.env.DB.prepare("UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?")
    .bind(now, now, c.req.param("id"), c.get("user").id)
    .run();
  return c.json({ ok: true });
});

/* ---------- AI (Workers AI) ---------- */

app.post("/ai/enrich", async (c) => {
  const b = await c.req.json<{ text?: string; today?: string }>().catch(() => ({}) as any);
  const text = String(b.text ?? "").trim().slice(0, 500);
  const today = DATE.test(String(b.today)) ? String(b.today) : new Date().toISOString().slice(0, 10);
  if (!text) return c.json({ error: "text_required" }, 400);
  return c.json(await enrichMemo(c.env, text, today));
});

app.post("/ai/plan", async (c) => {
  const b = await c.req.json<{ text?: string; today?: string }>().catch(() => ({}) as any);
  const text = String(b.text ?? "").trim().slice(0, 3000);
  const today = DATE.test(String(b.today)) ? String(b.today) : new Date().toISOString().slice(0, 10);
  if (!text) return c.json({ error: "text_required" }, 400);
  try {
    return c.json(await planTasks(c.env, text, today));
  } catch (e) {
    console.warn("plan failed", e);
    return c.json({ error: "ai_failed" }, 502);
  }
});

const MAX_AUDIO = 8 * 1024 * 1024;
app.post("/ai/transcribe", async (c) => {
  const len = Number(c.req.header("content-length") || 0);
  if (len > MAX_AUDIO) return c.json({ error: "too_large" }, 413);
  const audio = await c.req.arrayBuffer();
  if (!audio.byteLength) return c.json({ error: "audio_required" }, 400);
  if (audio.byteLength > MAX_AUDIO) return c.json({ error: "too_large" }, 413);
  try {
    return c.json(await transcribe(c.env, audio));
  } catch (e) {
    console.warn("transcribe failed", e);
    return c.json({ error: "ai_failed" }, 502);
  }
});

/* ---------- メール（個人・事業 = Gmail、大学 = Outlook。どれも読むだけ） ---------- */

const isSlot = (v: unknown): v is Slot => SLOTS.includes(v as Slot);
const cookieOpts = (c: any) => ({ httpOnly: true, secure: isHttps(c.req.url), sameSite: "Lax" as const, path: "/", maxAge: 600 });

app.get("/mail/connect/:slot", async (c) => {
  const slot = c.req.param("slot");
  if (!isSlot(slot)) return c.json({ error: "invalid_slot" }, 400);
  const state = generateState();
  const verifier = generateCodeVerifier();
  if (SLOT_PROVIDER[slot] === "microsoft") {
    if (!c.env.MS_CLIENT_ID || !c.env.MS_CLIENT_SECRET) return c.redirect("/?mail=ms-notready", 302);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const url = new URL(msAuthorizeUrl(c.env));
    url.search = new URLSearchParams({
      client_id: c.env.MS_CLIENT_ID, response_type: "code", redirect_uri: msRedirect(c), response_mode: "query",
      scope: MS_SCOPE, state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account",
    }).toString();
    setCookie(c, "flick_ms_state", state, cookieOpts(c));
    setCookie(c, "flick_ms_verifier", verifier, cookieOpts(c));
    return c.redirect(url.toString(), 302);
  }
  const url = google(c).createAuthorizationURL(state, verifier, ["openid", "email", "profile", GMAIL_SCOPE]);
  url.searchParams.set("access_type", "offline"); // 10:00 / 20:00 にサーバーから読むために必要
  url.searchParams.set("prompt", "consent select_account"); // 事業用など別のアカウントも選べるように
  url.searchParams.set("include_granted_scopes", "true");
  setCookie(c, "flick_oauth_state", state, cookieOpts(c));
  setCookie(c, "flick_oauth_verifier", verifier, cookieOpts(c));
  setCookie(c, "flick_oauth_purpose", `mail-${slot}`, cookieOpts(c));
  return c.redirect(url.toString(), 302);
});

app.get("/mail", async (c) => {
  const uid = c.get("user").id;
  const { results: sources } = await c.env.DB.prepare("SELECT slot, provider, email, status, connected_at, checked_at FROM mail_sources WHERE user_id = ?").bind(uid).all();
  const { results: items } = await c.env.DB.prepare(
    "SELECT slot, id, from_name, from_addr, subject, date, snippet, summary, task_title, task_due, link, read FROM mail_items WHERE user_id = ? ORDER BY date DESC",
  ).bind(uid).all();
  return c.json({ sources, items: items.map(rowToItem), outlookReady: Boolean(c.env.MS_CLIENT_ID && c.env.MS_CLIENT_SECRET) || c.env.E2E === "1" });
});

app.post("/mail/check", async (c) => {
  const uid = c.get("user").id;
  const last = await c.env.DB.prepare("SELECT MAX(checked_at) AS t, COUNT(*) AS n FROM mail_sources WHERE user_id = ?").bind(uid).first<{ t: number | null; n: number }>();
  if (!last?.n) return c.json({ error: "not_connected" }, 400);
  if (last.t && Date.now() - last.t < 60_000) return c.json({ error: "too_soon" }, 429);
  return c.json({ result: await refreshUser(c.env, uid) });
});

app.post("/mail/items/:slot/:id/read", async (c) => {
  const b = await c.req.json<{ read?: boolean }>().catch(() => ({}) as any);
  await c.env.DB.prepare("UPDATE mail_items SET read = ? WHERE user_id = ? AND slot = ? AND id = ?")
    .bind(b.read === false ? 0 : 1, c.get("user").id, c.req.param("slot"), c.req.param("id"))
    .run();
  return c.json({ ok: true });
});

app.delete("/mail/:slot", async (c) => {
  const uid = c.get("user").id;
  const slot = c.req.param("slot");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM mail_sources WHERE user_id = ? AND slot = ?").bind(uid, slot),
    c.env.DB.prepare("DELETE FROM mail_items WHERE user_id = ? AND slot = ?").bind(uid, slot),
  ]);
  return c.json({ ok: true });
});

const devOnly = (c: any) => c.env.E2E === "1" && ["localhost", "127.0.0.1"].includes(new URL(c.req.url).hostname);

/** E2E テスト専用：メールにつないだことにする（E2E フラグ + localhost のときだけ） */
app.post("/mail/dev-connect", async (c) => {
  if (!devOnly(c)) return c.notFound();
  const b = await c.req.json<{ slot?: string; token?: string; email?: string }>().catch(() => ({}) as any);
  const slot: Slot = isSlot(b.slot) ? b.slot : "personal";
  const email = String(b.email || (slot === "univ" ? "g0000000@tcu.ac.jp" : slot === "business" ? "aihp@example.com" : "tester@gmail.com"));
  await c.env.DB.prepare(
    `INSERT INTO mail_sources (user_id, slot, provider, email, token_enc, status, connected_at) VALUES (?, ?, ?, ?, ?, 'ok', ?)
     ON CONFLICT(user_id, slot) DO UPDATE SET token_enc = excluded.token_enc, email = excluded.email, status = 'ok'`,
  )
    .bind(c.get("user").id, slot, SLOT_PROVIDER[slot], email, await encryptToken(c.env, String(b.token || "e2e-refresh")), Date.now())
    .run();
  return c.json({ ok: true });
});

/** E2E テスト専用：10:00 / 20:00 の自動更新と同じ処理を今すぐ動かす */
app.post("/mail/dev-cron", async (c) => {
  if (!devOnly(c)) return c.notFound();
  await runScheduled(c.env);
  return c.json({ ok: true });
});

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "server_error" }, 500);
});

export default {
  fetch: app.fetch,
  /** 10:00 と 20:00（日本時間）にメールを読み込む（wrangler.jsonc の triggers.crons） */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(env));
  },
} satisfies ExportedHandler<Env>;
