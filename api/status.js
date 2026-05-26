// BioHarmonize pipeline status endpoint.
// Public read-only view of Dropbox folder counts + last-run info from all 3 agents.
// Used by the Cowork dashboard to render live pipeline state.
//
// Returns JSON shape:
// {
//   ok: true,
//   folders: { canonical: 0, review: 3, published: 0, done: 1, images: 0 },
//   files: { canonical: [...], review: [...], published: [...], done: [...], images: [...] },
//   lastRuns: {
//     agent_2: { ok, processed, results, timestamp },
//     agent_3: { ok, day, results, timestamp },
//     agent_4: { ok, processed, results, timestamp }
//   },
//   timestamp: "..."
// }

const FOLDERS = {
  canonical: "/BioHarmonize/01_Canonical_Approved",
  review: "/BioHarmonize/02_Derivatives_Review",
  published: "/BioHarmonize/03_Published",
  done: "/BioHarmonize/04_Done",
  images: "/BioHarmonize/Images",
};

const STATUS_FILES = {
  agent_2: "/BioHarmonize/_status/agent_2_last_run.json",
  agent_3: "/BioHarmonize/_status/agent_3_last_run.json",
  agent_4: "/BioHarmonize/_status/agent_4_last_run.json",
};

const ALERTS_FOLDER = "/BioHarmonize/_alerts";
// Alerts older than this are considered stale and excluded by default.
const ALERT_LOOKBACK_HOURS = 168; // 7 days

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var missing`);
  return v;
}

let cachedAccessToken = null;
let cachedExpiresAt = 0;

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) return cachedAccessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: need("DROPBOX_REFRESH_TOKEN"),
  });
  const auth = Buffer.from(`${need("DROPBOX_APP_KEY")}:${need("DROPBOX_APP_SECRET")}`).toString("base64");
  const res = await fetch("https://api.dropbox.com/oauth2/token", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Dropbox token refresh: ${res.status}`);
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  return cachedAccessToken;
}

async function listFolderSafe(path) {
  try {
    const token = await getAccessToken();
    const res = await fetch("https://api.dropboxapi.com/2/files/list_folder", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path, recursive: false, limit: 200 }),
    });
    if (!res.ok) return { count: 0, files: [], error: `${res.status}` };
    const data = await res.json();
    const entries = data.entries || [];
    const files = entries
      .filter((e) => e[".tag"] === "file")
      .map((e) => ({ name: e.name, size: e.size, modified: e.server_modified }));
    return { count: files.length, files };
  } catch (err) {
    return { count: 0, files: [], error: err.message };
  }
}

async function readJsonSafe(path) {
  try {
    const token = await getAccessToken();
    const res = await fetch("https://content.dropboxapi.com/2/files/download", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Dropbox-API-Arg": JSON.stringify({ path }),
      },
    });
    if (!res.ok) return null;
    const txt = await res.text();
    return JSON.parse(txt);
  } catch (err) {
    return null;
  }
}

// Fetches recent alert files from /_alerts/. Each alert JSON contains
// { ts, agent, severity, summary, detail, context }. Returns them sorted
// newest-first, capped to the most recent N within the lookback window.
async function getRecentAlerts({ lookbackHours = ALERT_LOOKBACK_HOURS, limit = 50 } = {}) {
  const listing = await listFolderSafe(ALERTS_FOLDER);
  if (!listing.files?.length) return { count: 0, alerts: [], lookbackHours };

  const cutoff = Date.now() - lookbackHours * 3600 * 1000;
  // Sort by server_modified (newest first) and slice before reading bodies
  const recent = listing.files
    .filter((f) => {
      if (!f.modified) return true;
      return new Date(f.modified).getTime() >= cutoff;
    })
    .sort((a, b) => new Date(b.modified || 0) - new Date(a.modified || 0))
    .slice(0, limit);

  const alerts = await Promise.all(
    recent.map(async (f) => {
      const body = await readJsonSafe(`${ALERTS_FOLDER}/${f.name}`);
      return body ? { ...body, _file: f.name, _modified: f.modified } : null;
    })
  );
  const cleaned = alerts.filter(Boolean);
  return { count: cleaned.length, alerts: cleaned, lookbackHours };
}

export default async function handler(req, res) {
  // CORS so the Cowork dashboard artifact can fetch this
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const folderEntries = await Promise.all(
      Object.entries(FOLDERS).map(async ([key, path]) => [key, await listFolderSafe(path)])
    );
    const folders = {};
    const files = {};
    for (const [key, result] of folderEntries) {
      folders[key] = result.count;
      files[key] = result.files.map((f) => f.name);
    }

    const [runEntries, alerts] = await Promise.all([
      Promise.all(
        Object.entries(STATUS_FILES).map(async ([key, path]) => [key, await readJsonSafe(path)])
      ),
      getRecentAlerts(),
    ]);
    const lastRuns = Object.fromEntries(runEntries);

    // Summarize alerts by severity for quick banner rendering
    const severityCounts = { error: 0, warning: 0, info: 0 };
    for (const a of alerts.alerts) {
      const sev = (a.severity || "info").toLowerCase();
      if (sev in severityCounts) severityCounts[sev] += 1;
    }

    return res.status(200).json({
      ok: true,
      folders,
      files,
      lastRuns,
      alerts: {
        count: alerts.count,
        lookbackHours: alerts.lookbackHours,
        severityCounts,
        items: alerts.alerts, // ordered newest-first
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, timestamp: new Date().toISOString() });
  }
}
