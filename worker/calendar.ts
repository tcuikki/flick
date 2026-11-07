import type { Env } from "./index";
import { ExpiredError, decryptToken, encryptToken, googleAccess } from "./mail";

/**
 * Google カレンダー（個人のアカウント）。
 * - 予定の表示：表示中（Google カレンダーでチェックが入っている）カレンダーの、その日の予定
 * - 追加・変更・削除：書き込めるカレンダーだけ（繰り返しの予定は、その日の1回だけを変える）
 * 時刻はすべて日本時間で扱う（Flick の利用者は日本にいる前提）
 */

export const CAL_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
export const CAL_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
const API = "https://www.googleapis.com/calendar/v3";
const TZ = "Asia/Tokyo";
const OFFSET = "+09:00";

export type CalInfo = { id: string; title: string; color: string; primary: boolean; writable: boolean };
/** start / end は日本時間。終日なら "YYYY-MM-DD"（end は翌日＝含まない）、時刻つきなら "YYYY-MM-DDTHH:MM" */
export type CalEvent = {
  id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean;
  location: string; description: string; color: string; editable: boolean; recurring: boolean;
  /** Google カレンダーの予定の色（"1"〜"11"）。"" はカレンダーの色のまま */
  colorId: string;
};
export type EventInput = { calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string; colorId: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** Google カレンダーの予定の色（colorId 1〜11）。指定がなければカレンダーの色 */
const EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb", "2": "#33b679", "3": "#8e24aa", "4": "#e67c73", "5": "#f6bf26", "6": "#f4511e",
  "7": "#039be5", "8": "#616161", "9": "#3f51b5", "10": "#0b8043", "11": "#d50000",
};

export const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** どんな時刻表記でも日本時間の "YYYY-MM-DDTHH:MM" にそろえる */
export function toJst(dateTime: string) {
  const t = Date.parse(dateTime);
  if (!Number.isFinite(t)) return dateTime.slice(0, 16);
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 16);
}

/** 入力を確かめて Google に送る形にする。おかしければ null */
export function validateInput(b: any): EventInput | null {
  const title = String(b?.title ?? "").trim().slice(0, 300);
  const allDay = Boolean(b?.allDay);
  const start = String(b?.start ?? "");
  const end = String(b?.end ?? "");
  const calendarId = String(b?.calendarId ?? "primary").slice(0, 300) || "primary";
  if (!title) return null;
  if (allDay ? !(DATE.test(start) && DATE.test(end)) : !(DATETIME.test(start) && DATETIME.test(end))) return null;
  if (!(end > start)) return null;
  const colorId = String(b?.colorId ?? "");
  if (!(colorId === "" || colorId in EVENT_COLORS)) return null;
  return { calendarId, title, start, end, allDay, location: String(b?.location ?? "").slice(0, 500), description: String(b?.description ?? "").slice(0, 5000), colorId };
}

const toGoogleTime = (v: string, allDay: boolean) => (allDay ? { date: v, dateTime: null, timeZone: null } : { dateTime: `${v}:00${OFFSET}`, timeZone: TZ, date: null });
const toGoogleBody = (e: EventInput) => ({
  summary: e.title,
  location: e.location,
  description: e.description,
  start: toGoogleTime(e.start, e.allDay),
  end: toGoogleTime(e.end, e.allDay),
  // null を送ると色を外して「カレンダーの色」に戻る
  colorId: e.colorId || null,
});

/* ---------- つないでいるアカウント ---------- */

type CalSource = { email: string; token_enc: string; status: string };

async function source(env: Env, userId: string) {
  return env.DB.prepare("SELECT email, token_enc, status FROM cal_sources WHERE user_id = ?").bind(userId).first<CalSource>();
}

export async function saveCalSource(env: Env, userId: string, email: string, refresh: string) {
  await env.DB.prepare(
    `INSERT INTO cal_sources (user_id, email, token_enc, status, connected_at) VALUES (?, ?, ?, 'ok', ?)
     ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, token_enc = excluded.token_enc, status = 'ok', connected_at = excluded.connected_at`,
  ).bind(userId, email, await encryptToken(env, refresh), Date.now()).run();
}

async function markExpired(env: Env, userId: string) {
  await env.DB.prepare("UPDATE cal_sources SET status = 'expired' WHERE user_id = ?").bind(userId).run();
}

export type CalStatus = { email: string; status: "ok" | "expired" } | null;

/** その人のアクセストークン。つないでいなければ null、許可が切れていれば ExpiredError */
async function access(env: Env, userId: string): Promise<{ token: string; src: CalSource } | null> {
  const src = await source(env, userId);
  if (!src) return null;
  if (src.status === "expired") throw new ExpiredError("expired");
  try {
    return { token: await googleAccess(env, await decryptToken(env, src.token_enc)), src };
  } catch (e) {
    if (e instanceof ExpiredError) await markExpired(env, userId);
    throw e;
  }
}

async function gcal(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  // 401 = トークンが無効、403 = カレンダーの許可がない（チェックを外して許可した等）→ つなぎ直しが必要
  if (res.status === 401) throw new ExpiredError("unauthorized");
  if (res.status === 403) {
    const j: any = await res.clone().json().catch(() => ({}));
    const reason = String(j?.error?.errors?.[0]?.reason ?? j?.error?.status ?? "");
    if (/insufficient|PERMISSION_DENIED|forbidden/i.test(reason) && !/rateLimit|quota/i.test(reason)) throw new CalForbidden(reason);
  }
  return res;
}

/** そのカレンダーには書き込めない（読むだけのカレンダー・他人の予定など） */
export class CalForbidden extends Error {}

/* ---------- 読む ---------- */

async function listCalendars(token: string): Promise<CalInfo[]> {
  const res = await gcal(token, "/users/me/calendarList?minAccessRole=reader&maxResults=100");
  if (!res.ok) {
    // カレンダー一覧の許可がなくても、メインのカレンダーだけは出す
    return [{ id: "primary", title: "カレンダー", color: "#039be5", primary: true, writable: true }];
  }
  const items: any[] = ((await res.json()) as any).items ?? [];
  return items
    .filter((c) => c.primary || (c.selected && !c.hidden))
    .map((c) => ({
      id: String(c.id),
      title: String(c.summaryOverride || c.summary || ""),
      color: String(c.backgroundColor || "#039be5"),
      primary: Boolean(c.primary),
      writable: c.accessRole === "owner" || c.accessRole === "writer",
    }))
    .sort((a, b) => Number(b.primary) - Number(a.primary));
}

function toEvent(e: any, cal: CalInfo): CalEvent | null {
  if (e.status === "cancelled") return null;
  const allDay = Boolean(e.start?.date);
  const start = allDay ? String(e.start.date) : toJst(String(e.start?.dateTime ?? ""));
  const end = allDay ? String(e.end?.date ?? addDays(e.start.date, 1)) : toJst(String(e.end?.dateTime ?? e.start?.dateTime ?? ""));
  // 他の人が主催の予定は、出席者として見ているだけなので変更しない
  const ownEvent = !e.organizer || e.organizer.self || e.organizer.email === cal.id || e.guestsCanModify === true;
  return {
    id: String(e.id),
    calendarId: cal.id,
    title: String(e.summary || "（タイトルなし）"),
    start, end, allDay,
    location: String(e.location ?? ""),
    description: String(e.description ?? ""),
    color: EVENT_COLORS[String(e.colorId)] ?? cal.color,
    editable: cal.writable && ownEvent && !e.locked,
    recurring: Boolean(e.recurringEventId),
    colorId: e.colorId && String(e.colorId) in EVENT_COLORS ? String(e.colorId) : "",
  };
}

/** その日（日本時間 0:00〜24:00）の予定。何日か分まとめて取るときは days を増やす */
export async function eventsForDay(env: Env, userId: string, date: string, days = 1): Promise<{ source: CalStatus; calendars: CalInfo[]; events: CalEvent[] }> {
  if (env.E2E === "1") return mockEventsForDay(env, userId, date, days);
  const src = await source(env, userId);
  if (!src) return { source: null, calendars: [], events: [] };
  let a;
  try {
    a = await access(env, userId);
  } catch (e) {
    if (e instanceof ExpiredError) return { source: { email: src.email, status: "expired" }, calendars: [], events: [] };
    throw e;
  }
  const { token } = a!;
  try {
    const calendars = await listCalendars(token);
    const q = new URLSearchParams({
      timeMin: `${date}T00:00:00${OFFSET}`, timeMax: `${addDays(date, days)}T00:00:00${OFFSET}`,
      singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: TZ,
    });
    const lists = await Promise.all(
      calendars.map(async (cal) => {
        const res = await gcal(token, `/calendars/${encodeURIComponent(cal.id)}/events?${q}`);
        if (!res.ok) return [];
        const items: any[] = ((await res.json()) as any).items ?? [];
        return items.map((e) => toEvent(e, cal)).filter((e): e is CalEvent => Boolean(e));
      }),
    );
    const events = lists.flat().sort((x, y) => (x.allDay === y.allDay ? x.start.localeCompare(y.start) : x.allDay ? -1 : 1));
    return { source: { email: src.email, status: "ok" }, calendars, events };
  } catch (e) {
    if (e instanceof ExpiredError || e instanceof CalForbidden) {
      await markExpired(env, userId);
      return { source: { email: src.email, status: "expired" }, calendars: [], events: [] };
    }
    throw e;
  }
}

/* ---------- 書く ---------- */

export type WriteResult = { event: CalEvent } | { ok: true } | "none" | "expired" | "forbidden" | "not_found";

async function writable(env: Env, userId: string) {
  const a = await access(env, userId).catch((e) => {
    if (e instanceof ExpiredError) return "expired" as const;
    throw e;
  });
  return a ?? ("none" as const);
}

const calOf = (calendarId: string, color = "#039be5"): CalInfo => ({ id: calendarId, title: "", color, primary: calendarId === "primary", writable: true });

export async function createEvent(env: Env, userId: string, input: EventInput): Promise<WriteResult> {
  if (env.E2E === "1") return mockWrite(env, userId, "create", input);
  const a = await writable(env, userId);
  if (typeof a === "string") return a;
  try {
    const res = await gcal(a.token, `/calendars/${encodeURIComponent(input.calendarId)}/events`, { method: "POST", body: JSON.stringify(toGoogleBody(input)) });
    if (res.status === 403 || res.status === 404) return "forbidden";
    if (!res.ok) throw new Error(`calendar insert ${res.status}`);
    return { event: toEvent(await res.json(), calOf(input.calendarId))! };
  } catch (e) {
    return writeError(env, userId, e);
  }
}

export async function updateEvent(env: Env, userId: string, eventId: string, input: EventInput): Promise<WriteResult> {
  if (env.E2E === "1") return mockWrite(env, userId, "update", input, eventId);
  const a = await writable(env, userId);
  if (typeof a === "string") return a;
  try {
    const res = await gcal(a.token, `/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(eventId)}`, {
      method: "PATCH", body: JSON.stringify(toGoogleBody(input)),
    });
    if (res.status === 404 || res.status === 410) return "not_found";
    if (res.status === 403) return "forbidden";
    if (!res.ok) throw new Error(`calendar patch ${res.status}`);
    return { event: toEvent(await res.json(), calOf(input.calendarId))! };
  } catch (e) {
    return writeError(env, userId, e);
  }
}

export async function deleteEvent(env: Env, userId: string, calendarId: string, eventId: string): Promise<WriteResult> {
  if (env.E2E === "1") return mockWrite(env, userId, "delete", { calendarId } as EventInput, eventId);
  const a = await writable(env, userId);
  if (typeof a === "string") return a;
  try {
    const res = await gcal(a.token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    if (res.status === 404 || res.status === 410) return { ok: true }; // もう消えている
    if (res.status === 403) return "forbidden";
    if (!res.ok) throw new Error(`calendar delete ${res.status}`);
    return { ok: true };
  } catch (e) {
    return writeError(env, userId, e);
  }
}

async function writeError(env: Env, userId: string, e: unknown): Promise<WriteResult> {
  if (e instanceof ExpiredError) {
    await markExpired(env, userId);
    return "expired";
  }
  if (e instanceof CalForbidden) return "forbidden";
  throw e;
}

/* ---------- E2E 用のモック（本番では使われない）。予定は Worker のメモリに置く ---------- */

const mockStore = new Map<string, CalEvent[]>();
const MOCK_CALENDARS: CalInfo[] = [
  { id: "primary", title: "tester@gmail.com", color: "#039be5", primary: true, writable: true },
  { id: "holidays", title: "日本の祝日", color: "#0b8043", primary: false, writable: false },
];

async function mockEventsForDay(env: Env, userId: string, date: string, days: number) {
  const src = await source(env, userId);
  if (!src) return { source: null, calendars: [], events: [] };
  try {
    await access(env, userId);
  } catch (e) {
    if (e instanceof ExpiredError) return { source: { email: src.email, status: "expired" as const }, calendars: [], events: [] };
    throw e;
  }
  const from = date;
  const to = addDays(date, days);
  const events = (mockStore.get(userId) ?? [])
    .filter((e) => (e.allDay ? e.start < to && e.end > from : e.start.slice(0, 10) < to && e.end > `${from}T00:00`))
    .sort((x, y) => (x.allDay === y.allDay ? x.start.localeCompare(y.start) : x.allDay ? -1 : 1));
  return { source: { email: src.email, status: "ok" as const }, calendars: MOCK_CALENDARS, events };
}

async function mockWrite(env: Env, userId: string, op: "create" | "update" | "delete", input: EventInput, eventId?: string): Promise<WriteResult> {
  const a = await writable(env, userId);
  if (typeof a === "string") return a;
  const cal = MOCK_CALENDARS.find((c) => c.id === input.calendarId);
  if (!cal) return "not_found";
  if (!cal.writable) return "forbidden";
  const list = mockStore.get(userId) ?? [];
  if (op === "delete") {
    mockStore.set(userId, list.filter((e) => e.id !== eventId));
    return { ok: true };
  }
  const prev = op === "update" ? list.find((e) => e.id === eventId) : undefined;
  if (op === "update" && !prev) return "not_found";
  const event: CalEvent = {
    id: prev?.id ?? `mock${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
    calendarId: input.calendarId, title: input.title, start: input.start, end: input.end, allDay: input.allDay,
    location: input.location, description: input.description, color: EVENT_COLORS[input.colorId] ?? cal.color, editable: true, recurring: false,
    colorId: input.colorId,
  };
  mockStore.set(userId, [...list.filter((e) => e.id !== event.id), event]);
  return { event };
}

/** E2E 用：読むだけのカレンダー（祝日）の予定を置く */
export function mockSeedHoliday(userId: string, date: string, title: string) {
  const list = mockStore.get(userId) ?? [];
  list.push({ id: `hol${date}`, calendarId: "holidays", title, start: date, end: addDays(date, 1), allDay: true, location: "", description: "", color: "#0b8043", editable: false, recurring: false, colorId: "" });
  mockStore.set(userId, list);
}
