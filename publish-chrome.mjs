/*
 * Uploads dist/apify-analytics-plus-chrome.zip to the Chrome Web Store and
 * submits it for review, using the credentials in .env (same directory):
 *
 *   CWS_CLIENT_ID / CWS_CLIENT_SECRET  OAuth desktop client in the
 *                                      apify-495105 Google Cloud project
 *   CWS_REFRESH_TOKEN                  long-lived token for awseeley@gmail.com
 *   CWS_EXTENSION_ID                   Web Store item id
 *
 *   node extensions/apify-analytics-plus/build.mjs
 *   node extensions/apify-analytics-plus/publish-chrome.mjs           # upload + publish
 *   node extensions/apify-analytics-plus/publish-chrome.mjs --check   # only verify auth + item status
 *   node extensions/apify-analytics-plus/publish-chrome.mjs --upload-only
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const ZIP = join(root, "dist", "apify-analytics-plus-chrome.zip");

const env = {};
for (const line of (await readFile(join(root, ".env"), "utf8")).split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
for (const k of ["CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN", "CWS_EXTENSION_ID"]) {
  if (!env[k]) throw new Error(`missing ${k} in .env`);
}

const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    client_secret: env.CWS_CLIENT_SECRET,
    refresh_token: env.CWS_REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const token = (await tokenResp.json()).access_token;
if (!token) throw new Error("could not obtain access token - refresh token may be revoked");
const auth = { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" };

const status = await (
  await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${env.CWS_EXTENSION_ID}?projection=DRAFT`,
    { headers: auth }
  )
).json();
// uploadState NOT_FOUND on a GET just means no draft upload is pending.
if (!status.crxVersion) {
  throw new Error(`cannot access item: ${JSON.stringify(status)}`);
}
console.log(`item ${env.CWS_EXTENSION_ID}: current version ${status.crxVersion}`);
if (process.argv.includes("--check")) process.exit(0);

const zip = await readFile(ZIP);
const upload = await (
  await fetch(`https://www.googleapis.com/upload/chromewebstore/v1.1/items/${env.CWS_EXTENSION_ID}`, {
    method: "PUT",
    headers: auth,
    body: zip,
  })
).json();
console.log(`upload: ${upload.uploadState}${upload.itemError ? " - " + upload.itemError.map((e) => e.error_detail).join("; ") : ""}`);
if (upload.uploadState !== "SUCCESS") process.exit(1);

if (process.argv.includes("--upload-only")) process.exit(0);

const publish = await (
  await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${env.CWS_EXTENSION_ID}/publish`, {
    method: "POST",
    headers: auth,
  })
).json();
console.log(`publish: ${publish.status?.join(", ") ?? JSON.stringify(publish)}`);
if (publish.statusDetail) console.log(publish.statusDetail.join("\n"));
