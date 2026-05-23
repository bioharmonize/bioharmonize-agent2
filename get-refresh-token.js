// One-time helper: get a Dropbox refresh token via OAuth2 authorization code flow.
// Run locally once with: node get-refresh-token.js
// Reads DROPBOX_APP_KEY and DROPBOX_APP_SECRET from .env.local.

import http from "http";
import fs from "fs";
import path from "path";
import { exec } from "child_process";

// Load .env.local
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
}

const APP_KEY = process.env.DROPBOX_APP_KEY;
const APP_SECRET = process.env.DROPBOX_APP_SECRET;
const REDIRECT = "http://localhost:8765/callback";

if (!APP_KEY || !APP_SECRET) {
  console.error("ERROR: DROPBOX_APP_KEY and DROPBOX_APP_SECRET must be set in .env.local");
  process.exit(1);
}

const authUrl = `https://www.dropbox.com/oauth2/authorize?client_id=${APP_KEY}&response_type=code&token_access_type=offline&redirect_uri=${encodeURIComponent(REDIRECT)}`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== "/callback") {
    res.writeHead(404); res.end("not found"); return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400); res.end("missing code"); return;
  }

  // Exchange code for refresh token
  const auth = Buffer.from(`${APP_KEY}:${APP_SECRET}`).toString("base64");
  const body = new URLSearchParams({
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT,
  });
  try {
    const tokenRes = await fetch("https://api.dropbox.com/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!tokenRes.ok) {
      const txt = await tokenRes.text();
      res.writeHead(500); res.end(`Token exchange failed: ${txt}`);
      console.error("Token exchange failed:", txt);
      process.exit(1);
    }
    const data = await tokenRes.json();
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<html><body style="font-family:sans-serif;padding:40px">
      <h1>Dropbox refresh token obtained!</h1>
      <p>Check your terminal for the token. You can close this tab.</p>
    </body></html>`);
    console.log("\n=== SUCCESS ===");
    console.log("DROPBOX_REFRESH_TOKEN=" + data.refresh_token);
    console.log("\nAdd this refresh token to your Vercel project's environment variables.");
    console.log("Also add DROPBOX_APP_KEY and DROPBOX_APP_SECRET (already in your .env.local).");
    console.log("\nThe access_token below expires in ~4 hours, but the refresh_token never expires.");
    console.log("access_token (for testing only):", data.access_token);
    setTimeout(() => process.exit(0), 1000);
  } catch (err) {
    res.writeHead(500); res.end(`Error: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
});

server.listen(8765, () => {
  console.log("Opening browser to Dropbox authorization page...");
  console.log("If it doesn't open, paste this URL into your browser:\n", authUrl, "\n");
  // Try to open browser automatically
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  exec(`${cmd} "${authUrl}"`);
});
