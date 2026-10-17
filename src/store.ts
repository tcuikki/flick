import { useSyncExternalStore } from "react";
import { api, ApiError } from "./api";
import { todayISO } from "./date";

export type Status = "todo" | "doing" | "done";
export const STATUSES: Status[] = ["todo", "doing", "done"];
export const STATUS_LABEL: Record<Status, string> = { todo: "未着手", doing: "進行中", done: "完了" };

export type Task = {
  id: string;
  title: string;
  note: string;
  status: Status;
  due_date: string | null;
  sort: number;
  created_at: number;
  updated_at: number;
  /** サーバー未反映の変更がある */
  dirty?: boolean;
  /** AI が整理した時刻（演出用・端末内のみ） */
  aiAt?: number;
  /** AI 整理中 */
  aiPending?: boolean;
};

export type User = { id: string; email: string; name: string; picture: string };
export type Auth = "unknown" | "in" | "out";

type State = {
  tasks: Task[];
  /** 削除待ち（取り消し猶予のため少し遅らせて送る） */
  deletes: { id: string; at: number }[];
  auth: Auth;
  user: User | null;
  /** 一覧を描画できるデータが揃ったか */
  ready: boolean;
  online: boolean;
  settings: { ai: boolean };
};

const K = { tasks: "flick:tasks:v1", deletes: "flick:deletes:v1", user: "flick:user", settings: "flick:settings", owner: "flick:owner" };
const UNDO_MS = 5000;

const load = <T,>(k: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(k);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};
const save = (k: string, v: unknown) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* 容量超過などは無視 */
  }
};

const hasCache = (() => {
  try { return localStorage.getItem(K.tasks) !== null; } catch { return false; }
})();

let state: State = {
  tasks: load<Task[]>(K.tasks, []).map((t) => ({ ...t, aiPending: false })),
  deletes: load(K.deletes, []),
  auth: "unknown",
  user: load<User | null>(K.user, null),
  ready: hasCache,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  settings: load(K.settings, { ai: true }),
};

const listeners = new Set<() => void>();
function set(patch: Partial<State> | ((s: State) => Partial<State>)) {
  const p = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...p };
  if ("tasks" in p) save(K.tasks, state.tasks.map(({ aiPending, ...t }) => t));
  if ("deletes" in p) save(K.deletes, state.deletes);
  if ("settings" in p) save(K.settings, state.settings);
  listeners.forEach((l) => l());
}

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(state), () => sel(state));
}

/* ---------- タスク操作（すべて楽観的更新 → 裏で同期） ---------- */

function patchTask(id: string, patch: Partial<Task>, opts: { dirty?: boolean } = {}) {
  set((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === id ? { ...t, ...patch, ...(opts.dirty === false ? {} : { dirty: true, updated_at: Date.now() }) } : t,
    ),
  }));
  if (opts.dirty !== false) scheduleSync();
}

export function addTask(text: string, extra: Partial<Task> = {}): Task {
  const now = Date.now();
  const task: Task = {
    id: crypto.randomUUID(),
    title: text.trim().slice(0, 500),
    note: "",
    status: "todo",
    due_date: null,
    sort: now,
    created_at: now,
    updated_at: now,
    dirty: true,
    ...extra,
  };
  set((s) => ({ tasks: [task, ...s.tasks] }));
  scheduleSync();
  if (!extra.title && state.settings.ai) void enrich(task.id, task.title);
  return task;
}

export const updateTask = (id: string, patch: Partial<Pick<Task, "title" | "note" | "status" | "due_date">>) =>
  patchTask(id, patch);

export const setStatus = (id: string, status: Status) => patchTask(id, { status });

export function deleteTask(id: string): Task | undefined {
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;
  set((s) => ({ tasks: s.tasks.filter((t) => t.id !== id), deletes: [...s.deletes, { id, at: Date.now() }] }));
  setTimeout(scheduleSync, UNDO_MS + 100);
  return task;
}

export function restoreTask(task: Task) {
  set((s) => ({
    tasks: [{ ...task, dirty: true, updated_at: Date.now() }, ...s.tasks.filter((t) => t.id !== task.id)],
    deletes: s.deletes.filter((d) => d.id !== task.id),
  }));
  scheduleSync();
}

export function setAiEnabled(ai: boolean) {
  set({ settings: { ...state.settings, ai } });
}

/* ---------- AI ---------- */

const waitAuth = () =>
  new Promise<void>((resolve) => {
    if (state.auth !== "unknown") return resolve();
    const off = store.subscribe(() => {
      if (state.auth !== "unknown") { off(); resolve(); }
    });
  });

async function enrich(id: string, original: string) {
  await waitAuth();
  if (state.auth !== "in" || !state.online) return;
  patchTask(id, { aiPending: true }, { dirty: false });
  try {
    const r = await api<{ title: string; due_date: string | null; ai: boolean }>("/api/ai/enrich", {
      method: "POST",
      body: { text: original, today: todayISO() },
    });
    const cur = state.tasks.find((t) => t.id === id);
    // ユーザーがすでに書き換えていたら AI の結果では上書きしない
    if (!cur || cur.title !== original) return;
    const changed = (r.title && r.title !== original) || (r.due_date && r.due_date !== cur.due_date);
    if (r.ai && changed) {
      patchTask(id, { title: r.title || original, due_date: r.due_date ?? cur.due_date, aiAt: Date.now() });
    }
  } catch {
    /* AI が使えなくてもメモはそのまま残る */
  } finally {
    patchTask(id, { aiPending: false }, { dirty: false });
  }
}

export async function breakdown(task: Task): Promise<Task[]> {
  const r = await api<{ steps: string[] }>("/api/ai/breakdown", {
    method: "POST",
    body: { title: task.title, note: task.note },
  });
  const now = Date.now();
  return r.steps
    .slice()
    .reverse()
    .map((step, i) =>
      addTask(step, { title: step, note: `↳ ${task.title}`, due_date: task.due_date, sort: now + i, created_at: now + i, aiAt: now }),
    );
}

/* ---------- 認証 ---------- */

export async function boot() {
  window.addEventListener("online", () => { set({ online: true }); scheduleSync(0); });
  window.addEventListener("offline", () => set({ online: false }));
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && scheduleSync(0));
  setInterval(() => document.visibilityState === "visible" && scheduleSync(0), 30_000);

  try {
    const { user } = await api<{ user: User }>("/api/me");
    adoptUser(user);
    await sync();
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      set({ auth: "out", user: null, ready: true });
      save(K.user, null);
    } else {
      // オフライン: 前回ログインしていればそのまま使う
      set({ auth: state.user ? "in" : "out", ready: true });
    }
  }
}

function adoptUser(user: User) {
  const owner = load<string | null>(K.owner, null);
  if (owner && owner !== user.id) {
    // 別アカウントのキャッシュは捨てる（ゲスト中のメモ = owner なし は引き継ぐ）
    set({ tasks: [], deletes: [] });
  }
  save(K.owner, user.id);
  save(K.user, user);
  set({ auth: "in", user });
}

export function login() {
  location.href = "/api/auth/google";
}

export async function logout() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch { /* noop */ }
  [K.tasks, K.deletes, K.user, K.owner].forEach((k) => save(k, null));
  set({ auth: "out", user: null, tasks: [], deletes: [] });
}

/* ---------- 同期（後勝ち。ローカル未送信の変更は守る） ---------- */

let timer: ReturnType<typeof setTimeout> | undefined;
let running = false;
let again = false;

export function scheduleSync(delay = 350) {
  clearTimeout(timer);
  timer = setTimeout(() => void sync(), delay);
}

export async function sync() {
  if (state.auth !== "in") return;
  if (running) { again = true; return; }
  running = true;
  try {
    // 1) 送信
    for (const t of state.tasks.filter((t) => t.dirty)) {
      const sent = t.updated_at;
      try {
        await api(`/api/tasks/${t.id}`, {
          method: "PUT",
          body: { title: t.title, note: t.note, status: t.status, due_date: t.due_date, sort: t.sort, created_at: t.created_at, updated_at: t.updated_at },
        });
        set((s) => ({ tasks: s.tasks.map((x) => (x.id === t.id && x.updated_at === sent ? { ...x, dirty: false } : x)) }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return handle401();
        if (e instanceof ApiError && e.status === 404) {
          // 他の端末で削除済み
          set((s) => ({ tasks: s.tasks.filter((x) => x.id !== t.id) }));
        } else if (!(e instanceof ApiError)) return; // オフライン
      }
    }
    const due = state.deletes.filter((d) => Date.now() - d.at >= UNDO_MS);
    for (const d of due) {
      try {
        await api(`/api/tasks/${d.id}`, { method: "DELETE" });
        set((s) => ({ deletes: s.deletes.filter((x) => x.id !== d.id) }));
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return handle401();
        if (!(e instanceof ApiError)) return;
      }
    }
    // 2) 受信してマージ
    const { tasks: remote } = await api<{ tasks: Task[] }>("/api/tasks");
    set((s) => {
      const local = new Map(s.tasks.map((t) => [t.id, t]));
      const pendingDelete = new Set(s.deletes.map((d) => d.id));
      const merged: Task[] = [];
      for (const r of remote) {
        if (pendingDelete.has(r.id)) continue;
        const l = local.get(r.id);
        if (l?.dirty && l.updated_at > r.updated_at) merged.push(l);
        else merged.push({ ...r, aiAt: l?.aiAt, aiPending: l?.aiPending });
        local.delete(r.id);
      }
      for (const l of local.values()) if (l.dirty) merged.push(l); // まだ届いていない新規
      return { tasks: merged, ready: true, online: true };
    });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return handle401();
    set({ ready: true });
  } finally {
    running = false;
    if (again) { again = false; scheduleSync(0); }
  }
}

function handle401() {
  save(K.user, null);
  set({ auth: "out", user: null, ready: true });
}

/** ブートスクリプトが JS 読み込み前に受け付けたメモを取り込む */
export function drainBootQueue() {
  const w = window as any;
  const q: { text: string; at: number }[] = w.__flickQueue || [];
  w.__flickQueue = [];
  try { localStorage.removeItem("flick:boot-queue"); } catch { /* noop */ }
  q.forEach((m) => addTask(m.text));
}
