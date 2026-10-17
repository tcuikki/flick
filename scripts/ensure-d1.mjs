// CI 用: D1 データベース flick-db が無ければ作り、その ID を wrangler.jsonc に書き込む。
// 何度実行しても同じ結果になる（冪等）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const NAME = "flick-db";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000000";
const wrangler = (...args) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

const find = () => JSON.parse(wrangler("d1", "list", "--json")).find((d) => d.name === NAME);

let db = find();
if (!db) {
  console.log(`Creating D1 database "${NAME}"...`);
  wrangler("d1", "create", NAME);
  db = find();
}
if (!db?.uuid) throw new Error("D1 database id not found");

const file = new URL("../wrangler.jsonc", import.meta.url);
const src = readFileSync(file, "utf8");
if (src.includes(PLACEHOLDER)) {
  writeFileSync(file, src.replace(PLACEHOLDER, db.uuid));
  console.log(`wrangler.jsonc: database_id = ${db.uuid}`);
} else {
  console.log("wrangler.jsonc already has a database_id");
}
