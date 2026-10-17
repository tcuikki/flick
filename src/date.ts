const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayISO = () => iso(new Date());

export function addDaysISO(n: number) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
}

function diffDays(dateISO: string) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - today) / 86_400_000);
}

/** 期限の表示（今日 / 明日 / 10/20(火) など）と状態 */
export function dueLabel(dateISO: string): { text: string; tone: "overdue" | "soon" | "normal" } {
  const n = diffDays(dateISO);
  const [y, m, d] = dateISO.split("-").map(Number);
  const wd = WEEK[new Date(y, m - 1, d).getDay()];
  if (n < 0) return { text: n === -1 ? "昨日" : `${m}/${d}(${wd})`, tone: "overdue" };
  if (n === 0) return { text: "今日", tone: "soon" };
  if (n === 1) return { text: "明日", tone: "soon" };
  if (n === 2) return { text: "明後日", tone: "normal" };
  const thisYear = y === new Date().getFullYear();
  return { text: `${thisYear ? "" : `${y}/`}${m}/${d}(${wd})`, tone: "normal" };
}

export function headerDate() {
  const d = new Date();
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}曜日`;
}
