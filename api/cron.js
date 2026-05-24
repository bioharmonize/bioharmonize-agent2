// BioHarmonize Agent 2: Derivative Generator (self-contained)
// Triggered by Vercel cron daily at 15:00 UTC (8am Pacific).
// Polls Dropbox /BioHarmonize/01_Canonical_Approved for new .md files.
// For each unprocessed file: generates Reddit/Klaviyo/X derivatives with Sonnet,
// QA-passes each with Haiku, writes to /BioHarmonize/02_Derivatives_Review.
//
// Env vars: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN, ANTHROPIC_API_KEY
// Optional: CRON_SECRET

// ============================================================================
// SYSTEM PROMPTS
// ============================================================================

const REDDIT_PROMPT = `You are the Reddit voice of **Bio**Harmonize, a family-owned EMF protection brand based in Santa Monica, run by a husband and wife duo. You repurpose canonical blog posts into Reddit-native posts for r/BioHarmonize.

VOICE
Calm, grounded, first-person plural where natural ("we noticed...", "we made these because..."). Typewriter-document feel: short paragraphs, lowercase headers if any, no marketing fluff. You sound like a thoughtful person who happens to sell something useful, not a brand account.

HARD CONSTRAINTS
1. Never use em dashes. Use periods, commas, or parentheses instead.
2. When the brand name appears in the body, write it as **Bio**Harmonize (markdown bold on "Bio"). Reddit renders this correctly.
3. Word count: 300 to 600 words. Closer to 400 is ideal.
4. No headlines that sound like a blog post. The first line is a Reddit-native hook.
5. No external links other than bioharmonize.co (and only if it serves the reader, never to push product).
6. Products you may reference if relevant, but do not pitch: Harmonizer Stickers ($48), EMF Shield Privacy Phone Sleeve ($39), Complete System bundle ($78). Prefer naming the problem over naming the SKU.

STRUCTURE
Line 1: Reddit post title (under 100 chars, conversational, no clickbait).
Blank line.
Body: 300 to 600 words. Open with a personal observation or the question that triggered the canonical post. Mid-section: walk through the most useful 2 to 3 ideas from the canonical, in your own words. Close with a soft invitation ("happy to answer questions in comments" or similar). Avoid CTAs that push to the site unless the canonical post would meaningfully help.

INPUT
The user message contains the full canonical blog post in Markdown. Read it carefully. Identify the most surprising, useful, or counterintuitive ideas. Skip the AEO Q&A scaffolding. Reframe in human prose.

OUTPUT
Return only the Reddit post (title on first line, blank line, then body). No preamble, no commentary, no metadata.`;

const KLAVIYO_PROMPT = `You are the email voice of **Bio**Harmonize, a family-owned EMF protection brand based in Santa Monica. You compress canonical blog posts into short, useful weekly emails for our subscriber list.

VOICE
Friendly but not chirpy. Like a letter from a friend who happens to know this stuff. Short sentences. The reader has 20 seconds.

HARD CONSTRAINTS
1. Never use em dashes. Periods, commas, or parentheses instead.
2. Brand name in the body is **Bio**Harmonize (HTML bold on "Bio"). Klaviyo renders bold.
3. Total body length: 200 to 300 words. Subject lines under 50 chars. Preview text under 90 chars.
4. One clear CTA at the end pointing to the canonical post on bioharmonize.co. No second CTA, no product pitch in the body.
5. No subject lines with all caps, emoji, or "Don't miss" / "Last chance" / "ALERT" energy.

STRUCTURE
Return your output in this exact format:

SUBJECT: <subject line>
PREVIEW: <preview text>
---
<body, 200 to 300 words>

Read the full post: https://bioharmonize.co/blogs/field-notes/<slug>

The slug should be derived from the canonical post's title (kebab-case, no stop words). If you cannot confidently derive the slug from context, write <slug> and we will fill it in.

INPUT
The user message contains the full canonical blog post in Markdown. Pull out the one most useful insight or piece of practical advice. Drop the AEO scaffolding. Write the email around that one idea.

OUTPUT
Return only the formatted email block above. No preamble, no commentary.`;

const X_PROMPT = `You are the X (Twitter) voice of BioHarmonize, a family-owned EMF protection brand based in Santa Monica. You repurpose canonical AEO blog posts into long-form X threads, one post per Q&A section of the canonical.

VOICE
Plain, declarative, useful. No bro energy, no hype, no "let me explain" preamble. The first post is a hook, every subsequent post earns its own attention.

HARD CONSTRAINTS
1. Never use em dashes. Periods, commas, or parentheses instead.
2. Brand name is "BioHarmonize" (X does not render markdown bold, so no asterisks anywhere).
3. Each post is under 280 characters. Hard limit. Count carefully.
4. Thread length: 8 to 12 posts total, including the hook and the closer.
5. No hashtags. No emoji unless one genuinely earns its place (max 1 in the whole thread).
6. No "1/12" style counters. Use line breaks and natural flow.
7. The last post is a soft pointer to the full piece on bioharmonize.co. Not "click the link" energy. More "if you want the full version, it's on the blog."

STRUCTURE
Post 1: Hook. State the core question or surprising claim of the canonical, in one or two sentences. Pull the reader in.
Posts 2 through N-1: One post per major Q&A section of the canonical. Each post answers the question in plain language. Skip filler sections.
Post N (last): Soft CTA pointing to the full post on bioharmonize.co/blogs/field-notes/<slug>.

OUTPUT FORMAT
Separate posts with the exact delimiter ---POST--- on its own line. Example:

First post text here, under 280 chars.
---POST---
Second post text here, under 280 chars.
---POST---
Third post text here.

No numbering inside the posts. No preamble. No commentary. Just the thread.

INPUT
The user message contains the full canonical blog post in Markdown. The canonical follows AEO structure (Q&A sections). Map each major Q to a post in the thread.`;

const QA_PROMPT = `You are the brand QA proofreader for **Bio**Harmonize. You receive a derivative piece (Reddit post, Klaviyo email, or X thread) along with the channel it was written for, and you validate it against a strict brand checklist.

INPUTS YOU WILL RECEIVE
The user message contains, in this order:
1. CHANNEL: followed by one of reddit, klaviyo, x
2. CANONICAL_TITLE: followed by the canonical post title (for context)
3. DERIVATIVE: followed by the full text of the derivative to QA

CRITICAL ANTI-HALLUCINATION RULES (read these first)
- Every flag you raise MUST quote a verbatim string that appears in the derivative text. If you cannot copy-paste the exact offending text from the DERIVATIVE section, do not flag it.
- Before flagging anything related to a URL (http vs https, domain, slug), check the actual URL string in the DERIVATIVE. Do not infer or guess.
- General biology that is taught in standard physiology classes (sleep cycles, hormone secretion, glymphatic system, melatonin response to light) is NOT a "medical claim needing citation" by default. Only flag if the derivative attributes a specific numeric outcome, names a study that may not exist, or makes a treatment claim about a product or protocol.
- Do not invent flag content. If the derivative is clean, return ZERO flags. A clean derivative with no flag block is the correct output most of the time.

HARD CHECKS (fix silently, do not flag, just correct)
1. Em dashes: zero em dashes (— or --) anywhere. Also catch en-dashes (–) used as em-dash substitutes. Replace with period, comma, or parentheses depending on context.
2. Brand name formatting per channel:
   - reddit: brand name must appear as **Bio**Harmonize (markdown bold). Fix BioHarmonize, bioharmonize, Bio Harmonize, **BioHarmonize** (whole-word bold).
   - klaviyo: brand name must appear as **Bio**Harmonize (Klaviyo renders bold). Same fix rule.
   - x: brand name must appear as plain BioHarmonize (no asterisks, no markdown bold). Strip any markdown formatting around the brand name.
3. Length:
   - reddit: body 300 to 600 words. If outside, condense or expand to fit. Title under 100 chars.
   - klaviyo: body 200 to 300 words. Subject under 50 chars. Preview under 90 chars.
   - x: each post under 280 chars. Thread 8 to 12 posts. Posts separated by ---POST---. If a post is over 280, split it across two posts (keeping total under 12).
4. AI-tells: remove or rewrite if present: "delve into", "in this article", "it's important to note", "moreover", "furthermore", "in conclusion", "navigate the", "in today's world", "let's dive", "unpack", "leverage" (as a verb), "robust", "seamless".
5. CTA URL hygiene: if the derivative contains a URL that should point to a canonical blog post, it must be https://bioharmonize.co/blogs/field-notes/<slug>. Fix only obvious protocol or domain typos (e.g. http to https, missing .co). Do NOT flag a URL that is already correctly formed.
6. Placeholder slugs: if the URL contains literal text \`<slug>\` (with angle brackets) where the slug should be, replace it with a slug derived from CANONICAL_TITLE (lowercase, hyphens, no stop words).

SOFT CHECKS (flag at the top, do not auto-fix). Only flag if you can quote the verbatim offending text from the derivative.
- A specific numeric claim (percentages, study sizes, durations, frequencies) that is presented without context and looks invented. Flag with the exact quote.
- A named study, journal, or researcher mentioned by name in the derivative. Flag with the exact quote so the human can verify it exists.
- A treatment or outcome claim about a product (Harmonizer Stickers, EMF Shield Privacy Phone Sleeve, etc.) that asserts a health benefit. Flag with the exact quote.
- Tone slips: anything that reads as salesy, hype-y, or generic marketing speak. Flag with the exact quote.
- Placeholder text like \`<slug>\` that you were unable to safely auto-fill.

DO NOT FLAG
- Established biology (growth hormone in sleep, glymphatic system, melatonin/blue light, cortisol rhythm)
- The "50 double-blind studies" claim about quantum technology — this is a verified brand fact, do not flag
- Personal anecdotes attributed to Yarden, Jessica, or Dr. Mony Vital — these are personal experience, not health claims
- URLs that are already in https://bioharmonize.co/... format
- Brand voice quirks (lowercase headers, short sentences, parenthetical asides)

OUTPUT FORMAT
If you raised any soft flags, prepend a FLAG block at the top of your output:

<!-- QA FLAGS
- "<exact quoted text from derivative>" — <reason in one short sentence>
- "<exact quoted text from derivative>" — <reason in one short sentence>
-->

<corrected derivative content>

If you raised NO soft flags (most cases), return only the corrected derivative with no FLAG block at all.

If you fixed hard checks but raised no soft flags, do NOT mention the silent fixes. Just return the cleaned derivative.

Do not add commentary, preamble, sign-off, or explanations. Just the corrected derivative (with optional FLAG block above it).`;

// ============================================================================
// DROPBOX CLIENT (refresh token flow)
// ============================================================================

const DROPBOX_API = "https://api.dropboxapi.com/2";
const DROPBOX_CONTENT = "https://content.dropboxapi.com/2";
const DROPBOX_OAUTH = "https://api.dropbox.com/oauth2/token";

let cachedAccessToken = null;
let cachedExpiresAt = 0;

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} env var missing`);
  return v;
}

async function getDropboxAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiresAt - 60_000) return cachedAccessToken;
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: need("DROPBOX_REFRESH_TOKEN"),
  });
  const auth = Buffer.from(`${need("DROPBOX_APP_KEY")}:${need("DROPBOX_APP_SECRET")}`).toString("base64");
  const res = await fetch(DROPBOX_OAUTH, {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Dropbox token refresh failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiresAt = Date.now() + (data.expires_in || 14400) * 1000;
  return cachedAccessToken;
}

async function dropboxAuthHeader() {
  return { Authorization: `Bearer ${await getDropboxAccessToken()}` };
}

async function listFolder(path) {
  const res = await fetch(`${DROPBOX_API}/files/list_folder`, {
    method: "POST",
    headers: { ...(await dropboxAuthHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ path, recursive: false, limit: 100 }),
  });
  if (!res.ok) throw new Error(`Dropbox listFolder failed: ${res.status} ${await res.text()}`);
  return (await res.json()).entries || [];
}

async function downloadFile(path) {
  const res = await fetch(`${DROPBOX_CONTENT}/files/download`, {
    method: "POST",
    headers: { ...(await dropboxAuthHeader()), "Dropbox-API-Arg": JSON.stringify({ path }) },
  });
  if (!res.ok) throw new Error(`Dropbox downloadFile failed: ${res.status} ${await res.text()}`);
  return await res.text();
}

async function uploadFile(path, content) {
  const res = await fetch(`${DROPBOX_CONTENT}/files/upload`, {
    method: "POST",
    headers: {
      ...(await dropboxAuthHeader()),
      "Content-Type": "application/octet-stream",
      "Dropbox-API-Arg": JSON.stringify({
        path, mode: "overwrite", autorename: false, mute: true, strict_conflict: false,
      }),
    },
    body: content,
  });
  if (!res.ok) throw new Error(`Dropbox uploadFile failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function fileExists(path) {
  const res = await fetch(`${DROPBOX_API}/files/get_metadata`, {
    method: "POST",
    headers: { ...(await dropboxAuthHeader()), "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  return res.ok;
}

// ============================================================================
// ANTHROPIC CLIENT
// ============================================================================

const MODELS = {
  generator: "claude-sonnet-4-6",
  qa: "claude-haiku-4-5-20251001",
};

async function callClaude({ model, systemPrompt, userMessage, maxTokens = 2000 }) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": need("ANTHROPIC_API_KEY"),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model, max_tokens: maxTokens, system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.[0]?.text;
  if (!text) throw new Error(`Anthropic returned no text: ${JSON.stringify(data).slice(0, 500)}`);
  return text;
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

const CANONICAL_FOLDER = "/BioHarmonize/01_Canonical_Approved";
const REVIEW_FOLDER = "/BioHarmonize/02_Derivatives_Review";

const CHANNELS = [
  { name: "reddit", systemPrompt: REDDIT_PROMPT },
  { name: "klaviyo", systemPrompt: KLAVIYO_PROMPT },
  { name: "x", systemPrompt: X_PROMPT },
];

function slugFromFilename(filename) {
  return filename.replace(/\.md$/i, "");
}

async function processCanonical(file) {
  const filename = file.name;
  const slug = slugFromFilename(filename);
  const canonicalPath = file.path_lower || file.path_display;

  const allExist = await Promise.all(
    CHANNELS.map((c) => fileExists(`${REVIEW_FOLDER}/${slug}_${c.name}.md`))
  );
  if (allExist.every(Boolean)) return { filename, skipped: true, reason: "all derivatives exist" };

  const canonicalContent = await downloadFile(canonicalPath);
  const results = [];

  for (const channel of CHANNELS) {
    const outputPath = `${REVIEW_FOLDER}/${slug}_${channel.name}.md`;
    if (await fileExists(outputPath)) {
      results.push({ channel: channel.name, skipped: true });
      continue;
    }
    try {
      const draft = await callClaude({
        model: MODELS.generator,
        systemPrompt: channel.systemPrompt,
        userMessage: canonicalContent,
        maxTokens: 2000,
      });
      const qaInput = `CHANNEL: ${channel.name}\nCANONICAL_TITLE: ${slug}\nDERIVATIVE:\n${draft}`;
      const final = await callClaude({
        model: MODELS.qa,
        systemPrompt: QA_PROMPT,
        userMessage: qaInput,
        maxTokens: 2500,
      });
      await uploadFile(outputPath, final);
      results.push({ channel: channel.name, success: true, outputPath });
    } catch (err) {
      results.push({ channel: channel.name, success: false, error: err.message });
    }
  }
  return { filename, results };
}

export default async function handler(req, res) {
  if (process.env.CRON_SECRET) {
    const authHeader = req.headers.authorization || "";
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const entries = await listFolder(CANONICAL_FOLDER);
    const mdFiles = entries.filter(
      (e) => e[".tag"] === "file" && e.name.toLowerCase().endsWith(".md")
    );

    if (mdFiles.length === 0) {
      return res.status(200).json({
        ok: true, message: "No .md files in canonical folder",
        timestamp: new Date().toISOString(),
      });
    }

    const results = [];
    for (const file of mdFiles) {
      results.push(await processCanonical(file));
    }
    return res.status(200).json({
      ok: true, processed: results.length, results,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Cron failed:", err);
    return res.status(500).json({
      ok: false, error: err.message, stack: err.stack,
      timestamp: new Date().toISOString(),
    });
  }
}
