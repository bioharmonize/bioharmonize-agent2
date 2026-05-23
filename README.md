# BioHarmonize Agent 2: Derivative Generator

Vercel-hosted cron that watches a Dropbox folder for new canonical blog posts and generates Reddit, Klaviyo email, and X thread derivatives using the Anthropic API. Each derivative passes through a Haiku QA proofreader before landing in the review folder.

## What it does

1. Once a day at 8am Pacific (15:00 UTC), Vercel cron pings `/api/cron`. You can also trigger it manually from the Vercel dashboard at any time.
2. The handler lists `.md` files in Dropbox `/BioHarmonize/01_Canonical_Approved/`
3. For each file not yet processed, downloads the content
4. Calls Claude Sonnet 4.6 three times (Reddit, Klaviyo, X) with channel-specific prompts
5. Calls Claude Haiku 4.5 three times to QA each derivative
6. Uploads the three final files to Dropbox `/BioHarmonize/02_Derivatives_Review/`

Idempotent: if `{slug}_reddit.md` already exists in the review folder, that channel is skipped on the next run.

## File structure

```
agent2-vercel/
├── api/
│   └── cron.js                 # Vercel function, triggered by cron
├── lib/
│   ├── dropbox.js              # Dropbox API client (list, download, upload, exists)
│   └── anthropic.js            # Anthropic Messages API client
├── prompts/
│   ├── reddit.js               # System prompt for Reddit derivative
│   ├── klaviyo.js              # System prompt for Klaviyo email
│   ├── x.js                    # System prompt for X thread
│   └── qa.js                   # System prompt for Haiku QA pass
├── test-local.js               # Run cron handler locally
├── package.json
├── vercel.json                 # Cron schedule
└── .gitignore
```

## Setup

### 1. Get Dropbox credentials (3 values: App key, App secret, Refresh token)

The Dropbox app `BioHarmonize-Agent2` has already been created and scoped (`files.metadata.read`, `files.content.read`, `files.content.write`). You just need to grab the credentials.

a. Open https://www.dropbox.com/developers/apps and click **BioHarmonize-Agent2**
b. Copy the **App key** from the Settings tab. Save to 1Password labeled "Dropbox App Key"
c. Next to **App secret**, click **Show** and copy the secret. Save to 1Password labeled "Dropbox App Secret"
d. To get a Refresh token (so the cron survives indefinitely), you'll run a one-time setup script locally:

   In this folder, create `.env.local` with your app key and secret:
   ```
   DROPBOX_APP_KEY=<paste app key here>
   DROPBOX_APP_SECRET=<paste app secret here>
   ```

   Then run:
   ```bash
   node get-refresh-token.js
   ```

   This opens your browser to Dropbox's authorization page. Sign in to your Dropbox (same account that owns `/BioHarmonize/`), click Allow. The script captures the response and prints `DROPBOX_REFRESH_TOKEN=...` to your terminal. Copy that value, save to 1Password labeled "Dropbox Refresh Token".

### 2. Push this folder to GitHub

a. Create a new GitHub repo named `bioharmonize-agent2` (private is fine)
b. From your terminal, in this folder:
   ```bash
   git init
   git add .
   git commit -m "Initial Agent 2 derivative generator"
   git branch -M main
   git remote add origin https://github.com/<your-username>/bioharmonize-agent2.git
   git push -u origin main
   ```

### 3. Deploy to Vercel

a. Go to https://vercel.com and sign in (use GitHub for fastest setup)
b. Click **Add New > Project**
c. Pick the `bioharmonize-agent2` repo, click **Import**
d. Framework: **Other** (Vercel auto-detects, leave defaults)
e. Before clicking Deploy, expand **Environment Variables** and add:
   - `ANTHROPIC_API_KEY` = your Anthropic key (from 1Password)
   - `DROPBOX_APP_KEY` = the app key from Step 1
   - `DROPBOX_APP_SECRET` = the app secret from Step 1
   - `DROPBOX_REFRESH_TOKEN` = the refresh token from Step 1
   - `CRON_SECRET` = any random long string (optional, prevents random hits to /api/cron)
f. Click **Deploy**

### 4. Verify cron is registered

a. After deploy, in your Vercel project, go to **Settings > Cron Jobs**
b. You should see `/api/cron` scheduled `0 15 * * *` (once a day at 15:00 UTC, which is 8am PT during PDT or 7am during PST)
c. Click **Trigger now** to run it once and verify

(Vercel Hobby plan limits cron jobs to once per day, which is plenty since we publish weekly. If you ever want more frequent runs, you can also hit the endpoint manually from the Vercel dashboard any time you drop a new canonical.)

### 5. Test end-to-end

a. Drop a `.md` file (your Bedroom Protocol draft, for example) into your Dropbox `/BioHarmonize/01_Canonical_Approved/` folder
b. In Vercel, go to your project > Settings > Cron Jobs, click **Trigger now** (or wait for the daily run)
c. Check `/BioHarmonize/02_Derivatives_Review/` after ~30-60 seconds. You should see three new files: `bedroom-protocol_reddit.md`, `bedroom-protocol_klaviyo.md`, `bedroom-protocol_x.md`
d. Open each and verify quality

## Local testing

To test locally without deploying:

1. Create `.env.local` in this folder:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   DROPBOX_APP_KEY=...
   DROPBOX_APP_SECRET=...
   DROPBOX_REFRESH_TOKEN=...
   ```
2. Run:
   ```bash
   node test-local.js
   ```

## Editing prompts

Each system prompt lives in `prompts/*.js`. Edit the file, commit, push. Vercel auto-deploys on push.

## Cost

Per canonical post processed:
- 3 Sonnet calls (~2000 input tokens, ~600 output tokens each) = ~$0.04
- 3 Haiku calls (~2500 input tokens, ~700 output tokens each) = ~$0.014

Total: ~$0.05 per canonical post. Weekly cadence = ~$0.20/month.

Vercel: free Hobby plan. Cron limited to once per day, which is fine for a weekly publishing cadence. You can also trigger the cron manually any time from the Vercel dashboard.
