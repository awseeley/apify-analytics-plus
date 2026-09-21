/*
 * Assembles loadable extension packages for Chrome, Edge, and Firefox from src/.
 *
 *   node extensions/apify-analytics-plus/build.mjs
 *
 * Chrome and Edge both run Manifest V3 / Chromium extensions, so their payload
 * is identical. Firefox runs the same MV3 source unmodified (it supports
 * promise-style chrome.* APIs) but needs a browser_specific_settings.gecko
 * block for AMO signing, and Firefox 128+ for MAIN-world content scripts
 * (token-sniffer.js). We emit one folder per browser so each can be loaded,
 * zipped, and submitted to its respective store independently.
 */
import { cp, rm, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const src = join(root, "src");
const dist = join(root, "dist");

const BROWSER_PATCHES = {
  chrome: {},
  edge: {},
  firefox: {
    // No background script since 0.3.3 (it existed only to relay hub syncs),
    // so there is nothing here to reconcile between Chrome's service worker
    // and Firefox's event page.
    browser_specific_settings: {
      gecko: {
        id: "apify-analytics-plus@apifyhub.com",
        // MAIN-world content_scripts (token-sniffer.js) need Firefox 128+.
        strict_min_version: "128.0",
        // AMO rejects new submissions without this declaration. "none" =
        // nothing is collected or transmitted to the developer or third
        // parties. True as of 0.3.3: the only network calls are to Apify's
        // own first-party backend, for the user who is already logged in.
        data_collection_permissions: {
          required: ["none"],
        },
      },
    },
  },
};

async function buildFor(browser) {
  const out = join(dist, browser);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await cp(src, out, { recursive: true });

  const manifestPath = join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  Object.assign(manifest, BROWSER_PATCHES[browser]);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

  const zipPath = join(dist, `apify-analytics-plus-${browser}.zip`);
  await rm(zipPath, { force: true });
  try {
    execFileSync("zip", ["-r", "-X", "-q", zipPath, ".", "-x", "*.DS_Store"], { cwd: out });
    console.log(`✓ ${browser.padEnd(6)} → ${out.replace(root + "/", "")}  +  ${zipPath.replace(root + "/", "")}`);
  } catch {
    console.log(`✓ ${browser.padEnd(6)} → ${out.replace(root + "/", "")}  (zip skipped: 'zip' CLI not found)`);
  }
}

await rm(dist, { recursive: true, force: true });
for (const browser of Object.keys(BROWSER_PATCHES)) {
  await buildFor(browser);
}
console.log("\nLoad unpacked:");
console.log("  Chrome  → chrome://extensions → Developer mode → Load unpacked → extensions/apify-analytics-plus/dist/chrome");
console.log("  Edge    → edge://extensions  → Developer mode → Load unpacked → extensions/apify-analytics-plus/dist/edge");
console.log("  Firefox → about:debugging → This Firefox → Load Temporary Add-on → extensions/apify-analytics-plus/dist/firefox/manifest.json");
