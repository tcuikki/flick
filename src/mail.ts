import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

export type Slot = "personal" | "business" | "univ";
export const SLOTS: Slot[] = ["personal", "business", "univ"];
export const SLOT_LABEL: Record<Slot, string> = { personal: "個人", business: "事業", univ: "大学" };

export type MailItem = {
  slot: Slot; id: string; from_name: string; from_addr: string; subject: string; date: number;
  snippet: string; summary: string; task_title: string | null; task_due: string | null; link: string; read: boolean;
};
export type MailSource = { slot: Slot; provider: "google" | "microsoft"; email: string; status: "ok" | "expired"; connected_at: number; checked_at: number | null };

type State = { loaded: boolean; sources: MailSource[]; items: MailItem[]; checking: boolean; openedAt: number };
const OPENED = "flick:mail-opened";
const loadOpened = () => { try { return Number(localStorage.getItem(OPENED)) || 0; } catch { return 0; } };

let state: State = { loaded: false, sources: [], items: [], checking: false, openedAt: loadOpened() };
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function useMail<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}
export const mailState = () => state;

export async function loadMail() {
  try {
    const r = await api<{ sources: MailSource[]; items: MailItem[] }>("/api/mail");
    set({ loaded: true, sources: r.sources, items: r.items });
  } catch {
    set({ loaded: true });
  }
}

/** 今すぐ更新。結果のメッセージを返す */
export async function refreshMailNow(): Promise<string> {
  set({ checking: true });
  try {
    const r = await api<{ result: Record<string, string> }>("/api/mail/check", { method: "POST" });
    await loadMail();
    const bad = Object.entries(r.result).filter(([, v]) => v !== "ok").map(([k]) => SLOT_LABEL[k as Slot]);
    return bad.length ? `${bad.join("・")}は読み込めませんでした` : "更新しました";
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return "少し待ってからもう一度押してください";
    return "更新できませんでした";
  } finally {
    set({ checking: false });
  }
}

/** Flick の中だけの既読・未読（メールサービス側は変えない） */
export async function setRead(item: MailItem, read: boolean) {
  set({ items: state.items.map((m) => (m.slot === item.slot && m.id === item.id ? { ...m, read } : m)) });
  try {
    await api(`/api/mail/items/${item.slot}/${encodeURIComponent(item.id)}/read`, { method: "POST", body: { read } });
  } catch {
    /* 次に開いたときに戻るだけ */
  }
}

/** その枠を全部既読にする（Flick の中だけ） */
export async function readAll(slot: Slot) {
  set({ items: state.items.map((m) => (m.slot === slot ? { ...m, read: true } : m)) });
  try { await api("/api/mail/read-all", { method: "POST", body: { slot } }); } catch { /* 次に開いたときに戻るだけ */ }
}

/** キーワード検索（古いメールも含む） */
export async function searchMail(slot: Slot, q: string): Promise<MailItem[]> {
  const r = await api<{ items: MailItem[] }>(`/api/mail/search?slot=${slot}&q=${encodeURIComponent(q)}`);
  return r.items;
}

/**
 * 本文の全文。サーバーは文字コードの名前とバイト列だけを返すので、ブラウザで文字にする
 * （日本語のメールに多い ISO-2022-JP / Shift_JIS もブラウザなら読める）
 */
export async function fetchBody(item: Pick<MailItem, "slot" | "id">): Promise<string | null> {
  const r = await api<{ body: { mime: string; charset: string; data: string } | null }>(
    `/api/mail/items/${item.slot}/${encodeURIComponent(item.id)}/body`,
  );
  if (!r.body) return null;
  const text = decodeBytes(r.body.data, r.body.charset);
  return r.body.mime === "text/html" ? htmlToText(text) : text.replace(/\r\n/g, "\n").trim();
}

export function decodeBytes(b64: string, charset: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes); // 知らない文字コード名のとき
  }
}

/** HTML メールを読める文字だけにする（スクリプトや見た目の指定は捨てる） */
export function htmlToText(html: string) {
  const marked = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n");
  const doc = new DOMParser().parseFromString(marked, "text/html");
  return (doc.body?.textContent ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function markOpened() {
  const now = Date.now();
  try { localStorage.setItem(OPENED, String(now)); } catch { /* noop */ }
  set({ openedAt: now });
}

export async function disconnectSlot(slot: Slot) {
  await api(`/api/mail/${slot}`, { method: "DELETE" });
  set({ sources: state.sources.filter((s) => s.slot !== slot), items: state.items.filter((m) => m.slot !== slot) });
}

export const connectSlot = (slot: Slot) => { location.href = `/api/mail/connect/${slot}`; };

/** 前に開いてから届いた未読（一覧の上のお知らせ用） */
export const newUnread = (s: Pick<State, "items" | "openedAt">) => s.items.filter((m) => !m.read && m.date > s.openedAt);

const hm = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

/** 次の自動更新（10:00 / 20:00） */
export function nextUpdateLabel(now = new Date()) {
  const h = now.getHours();
  if (h < 10) return "今日 10:00";
  if (h < 20) return "今日 20:00";
  return "明日 10:00";
}

export function dayTimeLabel(ms: number, now = new Date()) {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff === 0) return `今日 ${hm(d)}`;
  if (diff === 1) return `昨日 ${hm(d)}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`;
}

/** 一覧の時刻（今日なら時刻、それ以外は日付） */
export function listTime(ms: number, now = new Date()) {
  const d = new Date(ms);
  if (d.toDateString() === now.toDateString()) return hm(d);
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "昨日";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fullTime(ms: number) {
  const d = new Date(ms);
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  return `${d.getMonth() + 1}月${d.getDate()}日(${w}) ${hm(d)}`;
}
