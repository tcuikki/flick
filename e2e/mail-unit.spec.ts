import { expect, test } from "@playwright/test";
import { buildDigest, sourceOf } from "../worker/mail";

// ブラウザを使わない確認（振り分けと、AI の出力の扱い）
const raw = (i: number, h: Record<string, string>, labels: string[] = ["INBOX"], snippet = "冒頭の文") => ({
  id: `m${i}`, threadId: `t${i}`, labelIds: labels, snippet, internalDate: 1_000 + i, headers: h,
});

test.describe("メールの振り分け", () => {
  test("宛先が @icloud.com / @me.com / @mac.com なら iCloud（転送されたもの）", () => {
    expect(sourceOf({ to: "ringo@icloud.com" })).toBe("icloud");
    expect(sourceOf({ to: "Ringo <ringo@me.com>" })).toBe("icloud");
    expect(sourceOf({ cc: "x@mac.com" })).toBe("icloud");
    expect(sourceOf({ "x-forwarded-for": "ringo@icloud.com tester@gmail.com" })).toBe("icloud");
    expect(sourceOf({ to: "tester@gmail.com", "delivered-to": "tester@gmail.com" })).toBe("gmail");
    expect(sourceOf({ to: "icloud.com.fake@gmail.com" })).toBe("gmail");
  });

  test("広告・SNS は Gmail のカテゴリで決め、そこからはタスクを作らない", () => {
    const mails = [
      raw(0, { from: "店 <shop@example.com>", subject: "セール" }, ["INBOX", "CATEGORY_PROMOTIONS"]),
      raw(1, { from: '"教務課" <k@tcu.ac.jp>', subject: "提出のお願い" }, ["INBOX", "UNREAD"]),
    ];
    const ai = {
      mails: [{ i: 0, summary: "大事", kind: "action" as const }, { i: 1, summary: "提出が必要", kind: "action" as const }],
      tasks: [{ i: 0, title: "買う", due_date: null }, { i: 1, title: "書類を提出する", due_date: "2026-11-10" }, { i: 9, title: "存在しない", due_date: null }],
    };
    const { items, tasks } = buildDigest(mails, ai);
    const ad = items.find((m) => m.id === "m0")!;
    expect(ad.kind).toBe("ad");
    const k = items.find((m) => m.id === "m1")!;
    expect(k).toMatchObject({ fromName: "教務課", from: "k@tcu.ac.jp", kind: "action", unread: true, summary: "提出が必要" });
    expect(tasks).toEqual([{ title: "書類を提出する", due_date: "2026-11-10", status: "todo", note: "✉ 教務課「提出のお願い」", mailId: "m1" }]);
  });

  test("AI が失敗しても、件名と冒頭の文だけでまとめは作る", () => {
    const { items, tasks } = buildDigest([raw(0, { from: "a@b.c", subject: "" }, ["INBOX"], "本文の冒頭")], null);
    expect(items[0]).toMatchObject({ subject: "（件名なし）", summary: "本文の冒頭", snippet: "本文の冒頭", kind: "info" });
    expect(tasks).toEqual([]);
  });
});
