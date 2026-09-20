/*
 * Mints a fresh Chrome Web Store refresh token for publish-chrome.mjs.
 *
 * Google expires refresh tokens after 7 days while the OAuth consent app is
 * in "Testing" status, so this is needed whenever publish-chrome.mjs fails
 * with invalid_grant. It starts a loopback listener, prints the consent URL
 * (open it, pick awseeley@gmail.com, approve), catches the redirect, swaps
 * the code for tokens and rewrites CWS_REFRESH_TOKEN in .env.
 *
 *   node extensions/apify-analytics-plus/cws-auth.mjs
 *
 * To stop the 7-day expiry for good: Google Cloud console → project
 * apify-495105 → OAuth consent screen → Publishing status → "In production"
 * (the chromewebstore scope isn't sensitive, so no verification is needed).
 */
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const envPath = join(root, ".env");
const envText = await readFile(envPath, "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
if (!env.CWS_CLIENT_ID || !env.CWS_CLIENT_SECRET) throw new Error("missing CWS_CLIENT_ID / CWS_CLIENT_SECRET in .env");

const PORT = 8974;
const redirect = `http://127.0.0.1:${PORT}/`;
const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: env.CWS_CLIENT_ID,
    redirect_uri: redirect,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/chromewebstore",
    access_type: "offline",
    prompt: "consent",
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, redirect);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("no code in redirect: " + url.search);
    return;
  }
  try {
    const tok = await (
      await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: env.CWS_CLIENT_ID,
          client_secret: env.CWS_CLIENT_SECRET,
          redirect_uri: redirect,
          grant_type: "authorization_code",
        }),
      })
    ).json();
    if (!tok.refresh_token) throw new Error("token response had no refresh_token: " + JSON.stringify(tok));
    const next = envText.match(/^CWS_REFRESH_TOKEN=/m)
      ? envText.replace(/^CWS_REFRESH_TOKEN=.*$/m, `CWS_REFRESH_TOKEN=${tok.refresh_token}`)
      : envText.trimEnd() + `\nCWS_REFRESH_TOKEN=${tok.refresh_token}\n`;
    await writeFile(envPath, next);
    res.writeHead(200, { "content-type": "text/plain" }).end("Token saved to .env. You can close this tab.");
    console.log("refresh token saved to .env");
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    process.exitCode = 1;
  } finally {
    setTimeout(() => server.close(() => process.exit()), 200);
  }
});
server.listen(PORT, "127.0.0.1", () => {
  console.log("Open this URL, choose awseeley@gmail.com and approve:\n\n" + authUrl + "\n\nWaiting for the redirect on " + redirect + " (Ctrl-C to abort)...");
});
