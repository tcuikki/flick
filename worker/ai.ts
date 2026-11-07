import type { Env } from "./index";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

function addDays(iso: string, n: number) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isRealDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/** Workers AI の応答は JSON Mode でもモデルによって object / string の両方がありうる */
function parseResponse(raw: any): any {
  const r = raw?.response ?? raw;
  if (r && typeof r === "object") return r;
  if (typeof r === "string") {
    const m = r.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fallthrough */ }
    }
  }
  return null;
}

export type Enriched = { title: string; due_date: string | null; ai: boolean };

/**
 * 打った文から「期限の言葉」だけを文字どおり取り除いてタスク名にする。
 * AI にタイトルを書き直させると漢字が別の字に化けることがあったため、
 * AI には取り除く言葉を答えさせるだけにして、文字の書き換えは一切させない。
 * 言葉が文中にそのまま見つからない・長すぎる・取り除くと空になる場合は、打った文をそのまま使う。
 */
export function stripDuePhrase(text: string, phrase: unknown): string {
  if (typeof phrase !== "string") return text;
  const p = phrase.trim();
  if (!p || p.length > 24 || !text.includes(p)) return text;
  const title = text.replace(p, "").replace(/^[\s、，,・:：]+|[\s、，,・:：]+$/g, "").trim();
  return title || text;
}

/** メモ → タスク名（打った文から期限の言葉を除いたもの）+ 期限日 */
export async function enrichMemo(env: Env, text: string, today: string): Promise<Enriched> {
  if (env.E2E === "1") return mockEnrich(text, today);
  const weekday = WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()];
  try {
    const raw = await env.AI.run(env.AI_MODEL as any, {
      messages: [
        {
          role: "system",
          content:
            `あなたはタスク管理アプリの入力整理係です。ユーザーのメモから「期限を表す言葉」と「期限日」を取り出します。\n` +
            `今日は ${today}（${weekday}曜日）です。\n` +
            `- due_phrase: メモの中で期限を表している部分（「明日までに」「10月25日までに」「金曜中に」など、後ろの助詞も含む）を、メモから1文字も変えずにそのまま抜き出す。期限の言及がなければ null。\n` +
            `- due_date: 期限日を YYYY-MM-DD で。期限の言及がなければ null。\n` +
            `タスク名を書き直したり、要約したりしないこと。`,
        },
        { role: "user", content: text },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            due_phrase: { type: ["string", "null"] },
            due_date: { type: ["string", "null"] },
          },
          required: ["due_phrase", "due_date"],
        },
      },
      max_tokens: 120,
      temperature: 0,
    } as any);
    const j = parseResponse(raw);
    const due_date = isRealDate(j?.due_date) ? j.due_date : null;
    // 期限が読み取れたときだけ、期限の言葉を取り除く
    const title = due_date ? stripDuePhrase(text, j?.due_phrase) : text;
    return { title: title.slice(0, 500), due_date, ai: true };
  } catch (e) {
    console.warn("enrich failed", e);
    return { title: text, due_date: null, ai: false };
  }
}

export type PlannedTask = { title: string; due_date: string | null; status: "todo" | "doing"; note: string };

/**
 * 話した状況 → タスク案の一覧。
 * ここはタスク名を AI に作ってもらうしかないので、アプリ側でプレビューして人が確かめてから追加する。
 */
export async function planTasks(env: Env, text: string, today: string): Promise<{ tasks: PlannedTask[] }> {
  if (env.E2E === "1") return { tasks: mockPlan(text, today) };
  const weekday = WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()];
  const raw = await env.AI.run(env.AI_MODEL as any, {
    messages: [
      {
        role: "system",
        content:
          `あなたはタスク管理アプリの秘書です。ユーザーが話した「今の状況」から、ユーザーがやるべきことをタスクとして取り出します。\n` +
          `今日は ${today}（${weekday}曜日）です。\n` +
          `- tasks: やることの配列。最大10件。やることが無ければ空配列。\n` +
          `- title: 1つの行動を表す短い文（例「企業研究をする」）。ユーザーの言葉と漢字をできるだけそのまま使い、新しい情報を足さない。期限の言葉（「明日までに」など）は入れない。\n` +
          `- due_date: 期限日を YYYY-MM-DD で。「明日」「金曜」「来週」などは今日を基準に計算する。期限の言及がなければ null。\n` +
          `- status: すでに取りかかっている・途中だと言っていれば "doing"、それ以外は "todo"。\n` +
          `- note: 時刻や場所などの補足があれば短く。なければ空文字。`,
      },
      { role: "user", content: text },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                due_date: { type: ["string", "null"] },
                status: { type: "string", enum: ["todo", "doing"] },
                note: { type: "string" },
              },
              required: ["title", "due_date", "status"],
            },
          },
        },
        required: ["tasks"],
      },
    },
    max_tokens: 900,
    temperature: 0,
  } as any);
  const j = parseResponse(raw);
  return { tasks: cleanPlan(j?.tasks) };
}

/** AI の出力を検証して、アプリに入れられる形だけを残す */
export function cleanPlan(list: unknown): PlannedTask[] {
  if (!Array.isArray(list)) return [];
  const out: PlannedTask[] = [];
  for (const t of list) {
    const title = typeof t?.title === "string" ? t.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    if (!title) continue;
    out.push({
      title,
      due_date: isRealDate(t?.due_date) ? t.due_date : null,
      status: t?.status === "doing" ? "doing" : "todo",
      note: typeof t?.note === "string" ? t.note.trim().slice(0, 500) : "",
    });
    if (out.length >= 10) break;
  }
  return out;
}

/** 音声 → 文字（Workers AI の Whisper） */
export async function transcribe(env: Env, audio: ArrayBuffer): Promise<{ text: string }> {
  if (env.E2E === "1") return { text: "明日までに発表資料を作る。レポートを書いている途中" };
  const r: any = await env.AI.run("@cf/openai/whisper-large-v3-turbo" as any, {
    audio: toBase64(audio),
    language: "ja",
    condition_on_previous_text: false,
  } as any);
  return { text: typeof r?.text === "string" ? r.text.trim() : "" };
}

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** E2E 用の決定的なモック（本番では使われない）。タイトルは本番と同じ stripDuePhrase で作る */
function mockEnrich(text: string, today: string): Enriched {
  const rules: [RegExp, number][] = [
    [/(明後日|あさって)(までに|まで|中に)?/, 2],
    [/(明日|あした)(までに|まで|中に)?/, 1],
    [/(今日|きょう)(までに|まで|中に)?/, 0],
  ];
  for (const [re, n] of rules) {
    const m = text.match(re);
    if (m) return { title: stripDuePhrase(text, m[0]), due_date: addDays(today, n), ai: true };
  }
  return { title: text, due_date: null, ai: true };
}

/** E2E 用: 文ごとに1タスク。「途中」「やっている」を含めば進行中 */
function mockPlan(text: string, today: string): PlannedTask[] {
  return cleanPlan(
    text
      .split(/[。\n]/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((sentence) => {
        const e = mockEnrich(sentence, today);
        const doing = /途中|やっている/.test(sentence);
        return { title: e.title.replace(/途中$|をやっている$/, "").trim() || e.title, due_date: e.due_date, status: doing ? "doing" : "todo", note: "" };
      }),
  );
}
