// Scans the build for output the web client's CSP would block or that would
// weaken it: inline scripts, inline styles or handlers, eval-like calls.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const problems = [];

const html = readFileSync(join(dist, "index.html"), "utf8");
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
  if (!/\bsrc=/.test(match[1] ?? "") || (match[2] ?? "").trim() !== "")
    problems.push("index.html: inline <script>");
}
if (/\sstyle=/.test(html)) problems.push("index.html: style attribute");
if (/\son[a-z]+=/i.test(html))
  problems.push("index.html: inline event handler");
if (/<style\b/.test(html)) problems.push("index.html: <style> element");

for (const file of readdirSync(join(dist, "assets"))) {
  if (!file.endsWith(".js")) continue;
  const code = readFileSync(join(dist, "assets", file), "utf8");
  if (/\bnew Function\s*\(/.test(code)) problems.push(`${file}: new Function`);
  if (/(?<![\w$.])eval\s*\(/.test(code)) problems.push(`${file}: eval`);
  // kdbxweb (its generator name marks it) stays in the KDBX worker.
  if (/[`"']KdbxWeb[`"']/.test(code) && !file.startsWith("kdbx.worker-"))
    problems.push(`${file}: kdbxweb outside the KDBX worker`);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(
  "dist: no inline scripts, styles, handlers or eval; kdbxweb only in its worker",
);
