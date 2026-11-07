import { expect, test } from "@playwright/test";
import { parseBatch, parseFrom } from "../worker/mail";

// ブラウザを使わない確認（差出人の読み取り・Gmail バッチ応答）
test.describe("メールの読み込み（単体）", () => {
  test("差出人の名前とアドレスを分ける", () => {
    expect(parseFrom('"東京都市大学 教務課" <kyomu@tcu.ac.jp>')).toEqual({ name: "東京都市大学 教務課", email: "kyomu@tcu.ac.jp" });
    expect(parseFrom("Amazon <a@b.jp>")).toEqual({ name: "Amazon", email: "a@b.jp" });
    expect(parseFrom("only@addr.jp")).toEqual({ name: "only@addr.jp", email: "only@addr.jp" });
  });

  test("Gmail のバッチ応答（multipart）から各メールの JSON を取り出す", () => {
    const text = [
      "--batch_abc",
      "Content-Type: application/http",
      "Content-ID: <response-m0>",
      "",
      "HTTP/1.1 200 OK",
      "Content-Type: application/json; charset=UTF-8",
      "",
      '{"id":"1","threadId":"t1","labelIds":["UNREAD"],"snippet":"冒頭"}',
      "--batch_abc",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 404 Not Found",
      "",
      "not json",
      "--batch_abc",
      "Content-Type: application/http",
      "",
      "HTTP/1.1 200 OK",
      "",
      '{"id":"2","threadId":"t2","payload":{"headers":[{"name":"Subject","value":"{件名}"}]}}',
      "--batch_abc--",
    ].join("\r\n");
    const out = parseBatch(text);
    expect(out.map((m) => m.id)).toEqual(["1", "2"]);
    expect(out[1].payload.headers[0].value).toBe("{件名}");
  });
});
