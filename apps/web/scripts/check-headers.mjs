// Checks the security headers of a deployed web client:
// node apps/web/scripts/check-headers.mjs <site-url> <api-url>
import { contentSecurityPolicy } from "../csp.ts";

const [site, api] = process.argv.slice(2);
if (!site || !api) {
  console.error("usage: check-headers.mjs <site-url> <api-url>");
  process.exit(2);
}
const problems = [];

async function head(path) {
  const response = await fetch(new URL(path, site), { redirect: "manual" });
  await response.arrayBuffer();
  return response;
}

const page = await head("/");
const expected = {
  "content-security-policy": contentSecurityPolicy(api),
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cache-control": "no-cache",
};
for (const [name, value] of Object.entries(expected)) {
  if (page.headers.get(name) !== value)
    problems.push(
      `${name}: expected "${value}", got "${page.headers.get(name)}"`,
    );
}
if (!page.headers.get("strict-transport-security")?.includes("max-age="))
  problems.push("strict-transport-security missing");
if (!page.headers.get("permissions-policy")?.includes("camera=()"))
  problems.push("permissions-policy missing");

const config = await head("/config.json");
if (config.headers.get("cache-control") !== "no-cache")
  problems.push("config.json is cached");

const deepLink = await head("/account/sessions");
if (
  deepLink.status !== 200 ||
  !deepLink.headers.get("content-type")?.includes("text/html")
)
  problems.push("deep links do not serve index.html");

const html = await (await fetch(new URL("/", site))).text();
const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
if (!asset) problems.push("no script asset in index.html");
else {
  const response = await head(asset);
  if (!response.headers.get("cache-control")?.includes("immutable"))
    problems.push("assets are not immutable");
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`headers of ${site} are as expected`);
