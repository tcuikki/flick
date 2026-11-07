import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";

export type MailKind = "action" | "check" | "info" | "ad";
export type MailSource = "gmail" | "univ" | "icloud";
export const SOURCE_LABEL: Record<MailSource, string> = { gmail: "Gmail", univ: "大学", icloud: "iCloud" };
export type MailItem = {
  id: string; threadId: string; source: MailSource; from: string; fromName: string;
  subject: string; date: number; summary: string; snippet?: string; kind: MailKind; unread: boolean;
};
export type MailTask = { title: string; due_date: string | null; status: "todo"; note: string; mailId: string };
export type Digest = { id: string; created_at: number; since: number; total: number; items: MailItem[]; tasks: MailTask[]; seen_at: number | null };
export type MailAccount = { email: string; status: "ok" | "expired"; connected_at: number; last_checked_at: number | null };

type State = { loaded: boolean; account: MailAccount | null; digests: Digest[]; checking: boolean };
let state: State = { loaded: false, account: null, digests: [], checking: false };
const listeners = new Set<() => void>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };
const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function useMail<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state), () => sel(state));
}

export async function loadMail() {
  try {
    const r = await api<{ account: MailAccount | null; digests: Digest[] }>("/api/mail");
    set({ loaded: true, account: r.account, digests: r.digests });
  } catch {
    set({ loaded: true });
  }
}

/** 今すぐチェック。結果のメッセージを返す */
export async function checkMailNow(): Promise<string> {
  set({ checking: true });
  try {
    const r = await api<{ digest: Digest }>("/api/mail/check", { method: "POST" });
    set({ digests: [r.digest, ...state.digests].slice(0, 14) });
    return r.digest.items.length ? `${r.digest.items.length}件のメールが届いています` : "新しいメールはありません";
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (state.account) set({ account: { ...state.account, status: "expired" } });
      return "Gmailの接続が切れています";
    }
    if (e instanceof ApiError && e.status === 429) return "少し待ってからもう一度押してください";
    return "チェックできませんでした";
  } finally {
    set({ checking: false });
  }
}

export async function markSeen(id: string) {
  const d = state.digests.find((x) => x.id === id);
  if (!d || d.seen_at) return;
  set({ digests: state.digests.map((x) => (x.id === id ? { ...x, seen_at: Date.now() } : x)) });
  try { await api(`/api/mail/digests/${id}/seen`, { method: "POST" }); } catch { /* 次回また既読にする */ }
}

export async function disconnectMail() {
  await api("/api/mail", { method: "DELETE" });
  set({ account: null, digests: [] });
}

export const connectMail = () => { location.href = "/api/mail/connect"; };

/** 次の自動チェック（10:00 / 18:00） */
export function nextCheckLabel(now = new Date()) {
  const h = now.getHours();
  if (h < 10) return "今日 10:00";
  if (h < 18) return "今日 18:00";
  return "明日 10:00";
}

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
/** 「今日 18:00」「昨日 10:00」「11/5(木) 18:00」 */
export function digestLabel(ms: number, now = new Date()) {
  const d = new Date(ms);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (diff === 0) return `今日 ${hm}`;
  if (diff === 1) return `昨日 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEK[d.getDay()]}) ${hm}`;
}

export function timeLabel(ms: number, now = new Date()) {
  const d = new Date(ms);
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** Gmail で開くリンク（大学・iCloud から転送されたメールも Gmail にある） */
export const gmailLink = (threadId: string, email?: string) =>
  `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(email ?? "")}#all/${threadId}`;
