// Local test runner. Loads .env.local, runs the cron handler once, prints result.
// Usage: node test-local.js

import fs from "fs";
import path from "path";

// Load .env.local manually (no dotenv dep)
const envPath = path.join(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const k = trimmed.slice(0, idx).trim();
    const v = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
    process.env[k] = v;
  }
  console.log("Loaded .env.local");
}

const { default: handler } = await import("./api/cron.js");

const fakeReq = { headers: {} };
const fakeRes = {
  statusCode: 200,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(payload) {
    console.log(`\n=== Response (${this.statusCode}) ===`);
    console.log(JSON.stringify(payload, null, 2));
  },
};

await handler(fakeReq, fakeRes);
