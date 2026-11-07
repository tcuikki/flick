import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

/** Google カレンダー（個人のアカウント）。予定は日本時間の文字列で扱う（サーバーと同じ形） */
export type CalInfo = { id: string; title: string; color: string; primary: boolean; writable: boolean };
export type CalEvent = {
  id: string; calendarId: string; title: string; start: string; end: string; allDay: boolean;
  location: string; description: string; color: string; editable: boolean; recurring: boolean;
  /** Google カレンダーの予定の色（"1"〜"11"）。"" はカレンダーの色のまま */
  colorId: string;
};
export type EventInput = { calendarId: string; title: string; start: string; end: string; allDay: boolean; location: string; description: string; colorId: string };

/**
 * 予定の色と、その色を何に使っているか（りんごじゅうすの使い分け）。
 * id は Google カレンダーの予定の色の番号。"" はカレンダーの色のまま（＝ローズ。ジムに使っている）
 */
export type ColorChoice = { id: string; name: string; use: string; hex: string };
export const ROSE = "#e0607e";
export const MAIN_COLORS: ColorChoice[] = [
  { id: "7", name: "ピーコック", use: "バイト", hex: "#039be5" },
  { id: "", name: "ローズ", use: "ジム", hex: ROSE },
  { id: "8", name: "グラファイト", use: "勉強", hex: "#616161" },
  { id: "10", name: "バジル", use: "就活", hex: "#0b8043" },
  { id: "11", name: "トマト", use: "遊び", hex: "#d50000" },
  { id: "3", name: "ブドウ", use: "大学", hex: "#8e24aa" },
  { id: "5", name: "バナナ", use: "給料日", hex: "#f6bf26" },
];
export const OTHER_COLORS: ColorChoice[] = [
  { id: "1", name: "ラベンダー", use: "", hex: "#7986cb" },
  { id: "2", name: "セージ", use: "", hex: "#33b679" },
  { id: "4", name: "フラミンゴ", use: "", hex: "#e67c73" },
  { id: "6", name: "ミカン", use: "", hex: "#f4511e" },
  { id: "9", name: "ブルーベリー", use: "", hex: "#3f51b5" },
];
const ALL_COLORS = [...MAIN_COLORS, ...OTHER_COLORS];
export const colorChoice = (id: string) => ALL_COLORS.find((c) => c.id === id) ?? MAIN_COLORS[1];

/** 画面に出す色。色を付けていないメインのカレンダーの予定はローズで出す（Google カレンダーの見え方に合わせる） */
export function evColor(ev: Pick<CalEvent, "colorId" | "color" | "calendarId">, calendars: CalInfo[]) {
  if (ev.colorId) return colorChoice(ev.colorId).hex;
  const cal = calendars.find((c) => c.id === ev.calendarId);
  return !cal || cal.primary ? ROSE : ev.color;
}
export type CalSource = { email: string; status: "ok" | "expired" } | null;

type State = {
  /** undefined = まだ読み込んでいない */
  source: CalSource | undefined;
  calendars: CalInfo[];
  days: Record<string, CalEvent[]>;
  loading: Record<string, boolean>;
  failed: Record<string, boolean>;
};

const CACHE = "flick:cal";
function loadCache(): Partial<State> {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE) || "null");
    if (c && typeof c === "object" && c.days) return { source: c.source, calendars: c.calendars ?? [], days: c.days };
  } catch { /* noop */ }
  return {};
}

let state: State = { source: undefined, calendars: [], days: {}, loading: {}, failed: {}, ...loadCache() };
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const calState = () => state;

export function useCal<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

/** 端末に残すのは前後数日分だけ（次に開いたとき、通信を待たずに出すため） */
function saveCache() {
  try {
    const keep = Object.keys(state.days).sort().slice(-7);
    const days = Object.fromEntries(keep.map((d) => [d, state.days[d]]));
    localStorage.setItem(CACHE, JSON.stringify({ source: state.source, calendars: state.calendars, days }));
  } catch { /* noop */ }
}

export function clearCalCache() {
  try { localStorage.removeItem(CACHE); } catch { /* noop */ }
  set({ source: undefined, calendars: [], days: {}, loading: {}, failed: {} });
}

/* ---------- 日付と時刻 ---------- */

export const pad = (n: number) => String(n).padStart(2, "0");
export const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const today = () => isoOf(new Date());
export function shiftDate(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number);
  return isoOf(new Date(y, m - 1, d + n));
}
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
export function dateLabel(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return `${m}月${d}日（${WEEK[new Date(y, m - 1, d).getDay()]}）`;
}
export function relLabel(date: string) {
  const t = today();
  if (date === t) return "今日";
  if (date === shiftDate(t, 1)) return "明日";
  if (date === shiftDate(t, -1)) return "昨日";
  return null;
}
/** "YYYY-MM-DDTHH:MM" → その日の 0:00 からの分 */
export const minutesOf = (dt: string) => Number(dt.slice(11, 13)) * 60 + Number(dt.slice(14, 16));
export const hmOf = (dt: string) => `${Number(dt.slice(11, 13))}:${dt.slice(14, 16)}`;
export const atMinutes = (date: string, min: number) => {
  const day = Math.floor(min / 1440);
  const m = ((min % 1440) + 1440) % 1440;
  return `${shiftDate(date, day)}T${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

/** その日に重なる予定（終日は日付の範囲、時刻つきは 0:00〜24:00 にかかるもの） */
export function eventsOn(list: CalEvent[], date: string) {
  const next = shiftDate(date, 1);
  return list.filter((e) => (e.allDay ? e.start <= date && e.end > date : e.start < `${next}T00:00` && e.end > `${date}T00:00`));
}

export type Placed = { ev: CalEvent; top: number; height: number; col: number; cols: number; startMin: number; endMin: number };

/** 時刻つきの予定を縦に並べる。重なる予定は横に分けて並べる（Google カレンダーと同じ考え方） */
export function layoutDay(list: CalEvent[], date: string, hourPx: number, minHeight = 22): Placed[] {
  const next = shiftDate(date, 1);
  const items = list
    .filter((e) => !e.allDay)
    .map((ev) => {
      const s = ev.start < `${date}T00:00` ? 0 : minutesOf(ev.start);
      const e = ev.end > `${next}T00:00` || ev.end.slice(0, 10) > date ? 1440 : minutesOf(ev.end);
      return { ev, startMin: s, endMin: Math.max(e, s + 15) };
    })
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);

  const out: Placed[] = [];
  let cluster: typeof out = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(1, ...cluster.map((p) => p.col + 1));
    cluster.forEach((p) => (p.cols = cols));
    out.push(...cluster);
    cluster = [];
  };
  for (const it of items) {
    if (it.startMin >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((p) => p.endMin > it.startMin).map((p) => p.col));
    let col = 0;
    while (used.has(col)) col++;
    cluster.push({
      ev: it.ev, startMin: it.startMin, endMin: it.endMin, col, cols: 1,
      top: (it.startMin / 60) * hourPx,
      height: Math.max(minHeight, ((it.endMin - it.startMin) / 60) * hourPx - 2),
    });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return out;
}

/* ---------- 通信 ---------- */

export async function loadDay(date: string) {
  set({ loading: { ...state.loading, [date]: true } });
  try {
    const r = await api<{ source: CalSource; calendars: CalInfo[]; events: CalEvent[] }>(`/api/cal/events?date=${date}`);
    set({
      source: r.source,
      calendars: r.calendars.length ? r.calendars : state.calendars,
      days: { ...state.days, [date]: r.events },
      loading: { ...state.loading, [date]: false },
      failed: { ...state.failed, [date]: false },
    });
    saveCache();
  } catch {
    set({ loading: { ...state.loading, [date]: false }, failed: { ...state.failed, [date]: true } });
  }
}

/** 変更した予定がかかる日を読み直す */
function touchedDays(...evs: (Pick<CalEvent, "start" | "end" | "allDay"> | undefined)[]) {
  const ds = new Set<string>();
  for (const e of evs) if (e) ds.add(e.start.slice(0, 10));
  return [...ds].filter((d) => d in state.days);
}

function applyLocal(fn: (list: CalEvent[]) => CalEvent[]) {
  const days: Record<string, CalEvent[]> = {};
  for (const [d, list] of Object.entries(state.days)) days[d] = fn(list);
  set({ days });
}

export class CalWriteError extends Error {
  constructor(public code: string) { super(code); }
}
const errCode = (e: unknown) => (e instanceof ApiError ? e.code : "offline");

export async function createEvent(input: EventInput): Promise<CalEvent> {
  try {
    const r = await api<{ event: CalEvent }>("/api/cal/events", { method: "POST", body: input });
    const d = input.start.slice(0, 10);
    set({ days: { ...state.days, [d]: [...(state.days[d] ?? []), r.event] } });
    touchedDays(r.event).forEach((x) => void loadDay(x));
    return r.event;
  } catch (e) {
    if (e instanceof ApiError && e.code === "expired") markExpired();
    throw new CalWriteError(errCode(e));
  }
}

export async function updateEvent(ev: CalEvent, input: EventInput): Promise<void> {
  const before = state.days;
  const next: CalEvent = { ...ev, ...input };
  applyLocal((list) => list.map((x) => (x.id === ev.id && x.calendarId === ev.calendarId ? next : x)));
  const d = input.start.slice(0, 10);
  if (!(state.days[d] ?? []).some((x) => x.id === ev.id)) set({ days: { ...state.days, [d]: [...(state.days[d] ?? []), next] } });
  try {
    await api(`/api/cal/events/${encodeURIComponent(ev.calendarId)}/${encodeURIComponent(ev.id)}`, { method: "PATCH", body: input });
    touchedDays(ev, next).forEach((x) => void loadDay(x));
  } catch (e) {
    set({ days: before });
    if (e instanceof ApiError && e.code === "expired") markExpired();
    throw new CalWriteError(errCode(e));
  }
}

export async function deleteEvent(ev: CalEvent): Promise<void> {
  const before = state.days;
  applyLocal((list) => list.filter((x) => !(x.id === ev.id && x.calendarId === ev.calendarId)));
  try {
    await api(`/api/cal/events/${encodeURIComponent(ev.calendarId)}/${encodeURIComponent(ev.id)}`, { method: "DELETE" });
    saveCache();
  } catch (e) {
    set({ days: before });
    if (e instanceof ApiError && e.code === "expired") markExpired();
    throw new CalWriteError(errCode(e));
  }
}

function markExpired() {
  if (state.source) set({ source: { ...state.source, status: "expired" } });
}

export const connectCalendar = () => { location.href = "/api/cal/connect"; };

export async function disconnectCalendar() {
  await api("/api/cal", { method: "DELETE" });
  clearCalCache();
  set({ source: null });
}

export const writeErrorText = (code: string) =>
  code === "expired" ? "カレンダーとの接続が切れました。つなぎ直してください"
  : code === "forbidden" ? "このカレンダーには書き込めません"
  : code === "not_found" ? "その予定はもうありません"
  : code === "offline" ? "オフラインのため保存できませんでした"
  : "保存できませんでした";

/* ---------- 話した内容から予定を作る（AI） ---------- */

export type PlannedEvent = { title: string; date: string; end_date: string; start: string | null; end: string | null; all_day: boolean; location: string };

export async function planEventsWithAi(text: string, baseDate: string): Promise<PlannedEvent[]> {
  const r = await api<{ events: PlannedEvent[] }>("/api/ai/events", { method: "POST", body: { text, today: today(), date: baseDate } });
  return r.events;
}

/** 予定の名前から、いつもの色を推測する（りんごじゅうすの使い分け）。当てはまらなければ ""（カレンダーの色） */
const COLOR_RULES: [RegExp, string][] = [
  [/給料|給与/, "5"],
  [/ジム|筋トレ/, ""],
  [/【就活】|面接|面談|選考|説明会|インターン|ES提出|エントリー|内定/, "10"],
  [/就活|AIHP|AI×HP|事業|レポート|勉強|課題|資格|自習/, "8"],
  [/バイト|シフト|ニトリ|いけだ|Uber|ウーバー|ロケットナウ|配達/, "7"],
  [/授業|講義|ゼミ|研究室|限|大学|発表|試験|テスト/, "3"],
  [/遊び|飲み|ご飯|旅行|ライブ|映画|デート|カラオケ|当選|抽選/, "11"],
];
export function suggestColor(title: string): string {
  for (const [re, id] of COLOR_RULES) if (re.test(title)) return id;
  return "";
}
