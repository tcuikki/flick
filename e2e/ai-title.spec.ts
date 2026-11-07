import { expect, test } from "@playwright/test";
import { cleanPlan, stripDuePhrase } from "../worker/ai";
import { strangeKanji } from "../src/kanji";

// AI にタイトルを書き直させない（文字化け対策）ことの確認。ブラウザは使わない
test.describe("AI 自動整理のタイトル", () => {
  test("期限の言葉だけを文字どおり取り除く", () => {
    expect(stripDuePhrase("明日までに資料作成", "明日までに")).toBe("資料作成");
    expect(stripDuePhrase("AIHPのチラシを仕上げる 10月25日までに", "10月25日までに")).toBe("AIHPのチラシを仕上げる");
    expect(stripDuePhrase("金曜までに、富士通の事例研究・まとめ", "金曜までに")).toBe("富士通の事例研究・まとめ");
  });

  test("AI が文中にない言葉（化けた字など）を返したら、打った文をそのまま使う", () => {
    expect(stripDuePhrase("AIHPのチラシを仕上げる", "棗了る")).toBe("AIHPのチラシを仕上げる");
    expect(stripDuePhrase("富士通の事例研究", "出田トン")).toBe("富士通の事例研究");
  });

  test("期限の言葉がない・長すぎる・全文と同じ場合も、打った文をそのまま使う", () => {
    expect(stripDuePhrase("SPI対策", null)).toBe("SPI対策");
    expect(stripDuePhrase("SPI対策", "")).toBe("SPI対策");
    expect(stripDuePhrase("明日まで", "明日まで")).toBe("明日まで");
    const long = "あ".repeat(30);
    expect(stripDuePhrase(`${long}をやる`, long)).toBe(`${long}をやる`);
  });
});

test.describe("AI に頼む（タスク案）", () => {
  test("元の文に無い漢字（字化け）だけを目印にする", () => {
    const said = "金曜までにAIHPのチラシを仕上げる";
    expect(strangeKanji("AIHPのチラシを仕上げる", said)).toEqual([]);
    expect(strangeKanji("AIHPチラシを棗了る", said)).toEqual(["棗", "了"]);
    expect(strangeKanji("チラシを作る", said)).toEqual(["作"]);
  });

  test("AI の出力は検証してから使う（空・不正な日付・最大10件）", () => {
    const out = cleanPlan([
      { title: "  企業研究をする ", due_date: "2026-11-08", status: "doing", note: "10時" },
      { title: "", due_date: null, status: "todo" },
      { title: "日付が変", due_date: "2026-13-40", status: "???" },
      ...Array.from({ length: 20 }, (_, i) => ({ title: `t${i}`, due_date: null, status: "todo" })),
    ]);
    expect(out[0]).toEqual({ title: "企業研究をする", due_date: "2026-11-08", status: "doing", note: "10時" });
    expect(out[1]).toEqual({ title: "日付が変", due_date: null, status: "todo", note: "" });
    expect(out).toHaveLength(10);
    expect(cleanPlan(null)).toEqual([]);
  });
});
