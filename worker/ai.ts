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

/** メモ → 短いタスク名 + 期限日 */
export async function enrichMemo(env: Env, text: string, today: string): Promise<Enriched> {
  if (env.E2E === "1") return mockEnrich(text, today);
  const weekday = WEEK[new Date(`${today}T00:00:00Z`).getUTCDay()];
  try {
    const raw = await env.AI.run(env.AI_MODEL as any, {
      messages: [
        {
          role: "system",
          content:
            `あなたはタスク管理アプリの入力整理係です。ユーザーのメモから「タスク名」と「期限日」を取り出します。\n` +
            `今日は ${today}（${weekday}曜日）です。\n` +
            `- due_date: 期限や日付の言及があれば YYYY-MM-DD。なければ null。\n` +
            `- title: 元の言葉をできるだけ残し、期限表現（「明日までに」など）だけを除いた簡潔なタスク名。情報を足さない。言語は入力と同じ。`,
        },
        { role: "user", content: text },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            due_date: { type: ["string", "null"] },
          },
          required: ["title", "due_date"],
        },
      },
      max_tokens: 200,
      temperature: 0,
    } as any);
    const j = parseResponse(raw);
    const title = typeof j?.title === "string" && j.title.trim() ? j.title.trim().slice(0, 500) : text;
    return { title, due_date: isRealDate(j?.due_date) ? j.due_date : null, ai: true };
  } catch (e) {
    console.warn("enrich failed", e);
    return { title: text, due_date: null, ai: false };
  }
}

/** タスク → 3〜5 個の具体的なステップ */
export async function breakdownTask(env: Env, title: string, note: string): Promise<{ steps: string[] }> {
  if (env.E2E === "1") return { steps: [`${title}の準備`, `${title}を進める`, `${title}を見直す`] };
  try {
    const raw = await env.AI.run(env.AI_MODEL as any, {
      messages: [
        {
          role: "system",
          content:
            "あなたはタスク分解の専門家です。与えられたタスクを、すぐ着手できる具体的なステップ3〜5個に分けます。" +
            "各ステップは動詞で終わる20文字前後の短文。言語は入力と同じ。",
        },
        { role: "user", content: note ? `${title}\n補足: ${note}` : title },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: { steps: { type: "array", items: { type: "string" } } },
          required: ["steps"],
        },
      },
      max_tokens: 400,
      temperature: 0.3,
    } as any);
    const j = parseResponse(raw);
    const steps = Array.isArray(j?.steps)
      ? j.steps.filter((s: unknown) => typeof s === "string" && s.trim()).map((s: string) => s.trim().slice(0, 200)).slice(0, 5)
      : [];
    return { steps };
  } catch (e) {
    console.warn("breakdown failed", e);
    return { steps: [] };
  }
}

/** E2E 用の決定的なモック（本番では使われない） */
function mockEnrich(text: string, today: string): Enriched {
  const rules: [RegExp, number][] = [[/明後日|あさって/, 2], [/明日|あした/, 1], [/今日|きょう/, 0]];
  for (const [re, n] of rules) {
    if (re.test(text)) {
      const title = text.replace(re, "").replace(/^(まで(に)?|中に)\s*/, "").replace(/\s*(まで(に)?)$/, "").trim() || text;
      return { title, due_date: addDays(today, n), ai: true };
    }
  }
  return { title: text, due_date: null, ai: true };
}
