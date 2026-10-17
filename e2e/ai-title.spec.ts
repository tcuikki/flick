import { expect, test } from "@playwright/test";
import { stripDuePhrase } from "../worker/ai";

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
