# EcoBlocks

A Tetris-style puzzle game that teaches sustainability and global citizenship. Clear lines, then
complete sentences with the keywords from your blocks. React + Vite client, Express server, Postgres (Neon).

## Where play data goes

Every play session is saved to Postgres and mirrored automatically to a Google Spreadsheet:

| Tab | One row per | Notes |
|---|---|---|
| `Sessions` | play session | score, level, lines, duration, device, country, **End Reason** |
| `Answers` | sentence answer | linked to the session by `Play ID`, includes the sentence text |

- Test plays are synced too. Filter in the sheet (e.g. by Player Email).
- **End Reason**: `game_over` (lost), `left` (closed the tab mid-game), `no_end_signal` (no end message received; synced 60 min after start).
- A session is synced the moment it ends; failures are retried every minute, so Google outages don't lose data.
- Rows are keyed by Play ID, so a re-sync updates the row instead of duplicating it.
- Country/region come from the player's IP at session start. The IP itself is not stored.

## Setup

```bash
npm install
cp .env.example .env     # fill in the values
npm run db:push          # creates/updates the database tables
npm run dev              # http://localhost:5000
npm test
```

### Google Sheets (one-time)

1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project → **APIs & Services → Library → Google Sheets API → Enable**.
2. **IAM & Admin → Service Accounts → Create**. Open it → **Keys → Add key → JSON**. Download the file.
3. Open your spreadsheet → **Share** → add the service account's email (`...@...iam.gserviceaccount.com`) as **Editor**.
4. Set `GOOGLE_SERVICE_ACCOUNT_JSON` to the key file's contents (single line: `jq -c . key.json`) and `GOOGLE_SHEET_ID` to the ID from the spreadsheet URL.

On start the server creates the `Sessions` / `Answers` tabs and header rows if they are missing.
It logs `[sheets] Google Sheets sync enabled` when configured, or a warning when not.

## Deploying

GitHub stores the code and runs CI (`.github/workflows/ci.yml`), but it cannot run this server:
GitHub Pages only serves static files, and this app needs a Node server. Use a host that deploys from your GitHub repo, e.g. [Render](https://render.com):

1. **Before the first deploy with this version**, run `npm run db:push` once with the production `DATABASE_URL` (it adds `end_reason`, `updated_at`, `sheets_synced_at`). After that, all existing sessions are synced to the sheet automatically.
2. Render → **New → Web Service** → connect this GitHub repo.
3. Build command `npm ci && npm run build`, start command `npm start`.
4. Add the environment variables from `.env.example` (plus `NODE_ENV=production`).
5. Every push to the deployed branch redeploys.

Notes: free web services sleep when idle (the first visit after a pause is slow, and syncing pauses while asleep, then catches up).
Country detection reads the client IP from `X-Forwarded-For` with one trusted proxy hop; if your host puts two proxies in front, countries may be wrong.
