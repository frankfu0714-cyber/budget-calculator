# Cloudflare Workers

Serverless proxies used by the SplitCalc client. Deploy manually via the Cloudflare
dashboard or `wrangler`.

## `parse-expenses.js` — AI Paste

Client posts free-form text about group expenses; the Worker forwards to Google's
Gemini API and returns structured JSON that the client can render as a review
table.

### One-time deploy (dashboard, ~5 min)

1. Go to https://dash.cloudflare.com/ → **Workers & Pages** → **Create** → **Create Worker**.
2. Give it a name (e.g. `splitcalc-parse-expenses`). Note the `*.workers.dev` URL that Cloudflare shows.
3. Click **Edit code**. Delete the default handler, paste the full contents of `parse-expenses.js`, click **Deploy**.
4. Go to the Worker's **Settings** → **Variables and Secrets** → **Add**:
   - **Type**: Secret
   - **Variable name**: `GEMINI_KEY`
   - **Value**: your key from https://aistudio.google.com/apikey
5. Click **Deploy** again after adding the secret so it's picked up.
6. Test with `curl`:
   ```bash
   curl -X POST https://splitcalc-parse-expenses.<your-subdomain>.workers.dev/ \
     -H 'Content-Type: application/json' \
     -H 'Origin: https://frankfu0714-cyber.github.io' \
     -d '{"text":"Alice paid $50 for dinner, Bob paid $30 for cab"}'
   ```
   Expect a `200` with `{ participants: [...], expenses: [...] }`.
7. In `index.html`, set `AI_WORKER_URL` to the full Worker URL (find the constant
   near the AI-Paste code — it's the placeholder `https://REPLACE_ME.workers.dev`).

### CORS

`ALLOWED_ORIGINS` at the top of `parse-expenses.js` gates which origins may call
the Worker. Add any additional deploy targets (Vercel preview, custom domain,
etc.) there before deploying.

### Cost

Gemini 2.5 Flash is on the free tier for low volume. The Worker itself is free
up to 100k requests/day on Cloudflare's free plan. Personal-scale usage should
stay within both.

### Swapping models

Change `GEMINI_MODEL` at the top of `parse-expenses.js`. Options:

| Model | Speed | Quality | Cost |
|---|---|---|---|
| `gemini-2.5-flash` (default) | fast | good | free tier |
| `gemini-2.5-pro` | slower | best | paid tier |
| `gemini-2.0-flash-exp` | fast | good (older) | free tier |
