// Cloudflare Worker: Gemini-powered expense parser proxy.
//
// Deployment (see workers/README.md for detail):
//   1. Go to https://dash.cloudflare.com/ → Workers & Pages → Create Worker
//   2. Replace the default handler with this file's contents
//   3. Settings → Variables → add secret GEMINI_KEY (paste your Google AI Studio key)
//   4. Deploy. Copy the *.workers.dev URL and paste into AI_WORKER_URL in index.html
//   5. Add your domain(s) to ALLOWED_ORIGINS below before deploying.

const ALLOWED_ORIGINS = [
  'https://frankfu0714-cyber.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

// Gemini 2.5 Flash is the current-generation fast model (Jan 2026).
// Swap to `gemini-2.5-pro` for higher quality at the cost of latency.
const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are an expense-splitting assistant. Extract participants and expenses from natural-language text about group spending (dinners, trips, roommate bills, etc.). You MUST work in TWO PHASES: identify participants first, then extract expenses using those exact names.

Output STRICT JSON only — no markdown code fences, no prose:
{
  "participants": [ { "name": "string" } ],
  "expenses": [
    {
      "payer": "string (a participant name from the participants array above, verbatim)",
      "amount": number,
      "description": "string",
      "sharedBy": [ "string (participant names from the participants array)" ],
      "confidence": "high" | "medium" | "low",
      "note": "string, optional — only include if you had to guess"
    }
  ]
}

═══════════════════════════════════════════════════════════════
STEP 1 — Identify participants  (do this FIRST, before any expense extraction)
═══════════════════════════════════════════════════════════════
1a. Read the "Current participants" list from the user prompt if provided (it may be empty).
1b. Read the entire text and find every name that acts as the SUBJECT of a spending verb (paid, bought, covered, spent, 付了, 買了, 花了) OR that appears in a share phrase ("split with", "shared by", "for A and B", "跟…分").
1c. For each such token:
    - If it matches an existing participant name (case-insensitive), use the EXISTING name VERBATIM (preserve their spelling — e.g. if existing is "1", use "1", not "one").
    - If it's new (not in the existing list), add it as a new participant.
1d. Names may be numeric strings ("1", "2"), single letters ("A", "B"), emoji, or ordinary words. When you see such a token followed by a spending verb, it is the participant NAME, not a quantity. Example: "1 paid 100" means participant NAMED "1" paid amount 100 — the leading "1" is a PAYER, not a count.
1e. If "everyone" / "all" / "the group" / "we all" / "全部人" / "大家" appears anywhere in the text, treat it as a reference to ALL participants — meaning your final participants list must include every name from the "Current participants" list (plus any new ones you found in the text).
1f. Emit the FULL participants array as your first field. It contains: (a) every existing participant that was mentioned or implied, PLUS (b) every new participant you found. Never drop an existing participant that appears in the text.

═══════════════════════════════════════════════════════════════
STEP 2 — Extract expenses  (using the participants list from Step 1)
═══════════════════════════════════════════════════════════════
2a. For each spending event in the text, emit one expense object.
2b. The "payer" MUST be one of the names from your Step 1 participants array — do NOT invent names here.
2c. Amount rules:
    - Strip currency symbols (\$, NT\$, ¥, €, £), keep only the numeric value.
    - "1,200" → 1200 (thousands separators removed).
    - The word "total" before a number ("paid total 100", "共 100") means the NUMBER that follows is the amount — not that "total" itself is the amount.
    - If a row's amount is missing or unparseable, SKIP that row entirely. Do NOT emit it.
2d. sharedBy rules:
    - Default: sharedBy = ALL participants from your Step 1 list.
    - "split with X and Y" or "for A and B" → sharedBy = [X, Y] or [A, B].
    - "everyone joined" / "we all split X" / "全部人分" / "大家一起" → sharedBy = the FULL Step 1 participants list.
    - Never leave sharedBy empty. If truly unclear, default to all Step 1 participants.
2e. Description: short (≤ 60 chars), original language.
2f. Confidence:
    - "high" — payer and sharedBy are unambiguous from the text or existing participants list.
    - "medium" — you had to pick between two reasonable interpretations (e.g. "Alice and Bob split $80" — you picked Alice as payer).
    - "low" — you're guessing.
    Include a "note" explaining any medium / low choice.

═══════════════════════════════════════════════════════════════
GLOBAL RULES
═══════════════════════════════════════════════════════════════
- Support English and Traditional/Simplified Chinese input equally.
- Preserve original name spelling — do not translate or re-case unless the source is clearly ALL CAPS.
- Never invent amounts. Only numbers that literally appear in the text.
- Never invent participants. Only names that literally appear in the text OR the Current participants list.
- If the entire input is unrelated to expenses (random chat, greetings), return {"participants":[],"expenses":[]}.

═══════════════════════════════════════════════════════════════
EXAMPLES
═══════════════════════════════════════════════════════════════
Example A — with existingParticipants: ["1","2","3","4","5","6"]
Input: "1 paid total 100 for dinner (everyone joined)"
Output:
{
  "participants": [{"name":"1"},{"name":"2"},{"name":"3"},{"name":"4"},{"name":"5"},{"name":"6"}],
  "expenses": [
    {"payer":"1","amount":100,"description":"dinner","sharedBy":["1","2","3","4","5","6"],"confidence":"high"}
  ]
}

Example B — no existingParticipants (fresh session)
Input: "Alice paid 50 for lunch, then Bob paid 30, they split both"
Output:
{
  "participants": [{"name":"Alice"},{"name":"Bob"}],
  "expenses": [
    {"payer":"Alice","amount":50,"description":"lunch","sharedBy":["Alice","Bob"],"confidence":"high"},
    {"payer":"Bob","amount":30,"description":"","sharedBy":["Alice","Bob"],"confidence":"medium","note":"description not specified"}
  ]
}

Example C — with existingParticipants: ["Alice","Bob"] plus a new name in text
Input: "Alice paid \$80 for dinner, split with Bob and Charlie"
Output:
{
  "participants": [{"name":"Alice"},{"name":"Bob"},{"name":"Charlie"}],
  "expenses": [
    {"payer":"Alice","amount":80,"description":"dinner","sharedBy":["Alice","Bob","Charlie"],"confidence":"high"}
  ]
}

Example D — Chinese input with existingParticipants: ["阿明","小華","阿哲"]
Input: "阿明付了晚餐 NT\$1,200，大家一起分"
Output:
{
  "participants": [{"name":"阿明"},{"name":"小華"},{"name":"阿哲"}],
  "expenses": [
    {"payer":"阿明","amount":1200,"description":"晚餐","sharedBy":["阿明","小華","阿哲"],"confidence":"high"}
  ]
}`;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...(extra || {}) }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method_not_allowed' }, 405, headers);
    }
    if (!env.GEMINI_KEY) {
      return json({ error: 'missing_api_key', message: 'Worker is missing GEMINI_KEY secret' }, 500, headers);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'invalid_json_body' }, 400, headers); }

    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const hint = typeof body?.hint === 'string' ? body.hint.trim().slice(0, 200) : '';
    if (!text) return json({ error: 'text_required' }, 400, headers);
    if (text.length > 5000) return json({ error: 'text_too_long', max: 5000 }, 400, headers);

    // Optional context — the client passes the session's current participant
    // list so the model can resolve tokens like "1" or "A" to a named
    // participant instead of treating them as quantities.
    const existingParticipants = Array.isArray(body?.existingParticipants)
      ? body.existingParticipants
          .filter(x => typeof x === 'string')
          .map(x => x.trim())
          .filter(Boolean)
          .slice(0, 50)
      : [];

    const parts = [];
    if (existingParticipants.length) {
      parts.push(
        `Current participants in this session (use these names verbatim when they appear in the text; treat them as valid names even if they look like numbers, single characters, or emoji): [${existingParticipants.map(n => JSON.stringify(n)).join(', ')}]`
      );
    }
    if (hint) parts.push(`Additional context: ${hint}`);
    parts.push(`Text to parse:\n${text}`);
    const userPrompt = parts.join('\n\n');

    let geminiResp;
    try {
      geminiResp = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(env.GEMINI_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n' + userPrompt }] }],
          generationConfig: {
            temperature: 0.2,
            responseMimeType: 'application/json'
          }
        })
      });
    } catch (err) {
      return json({ error: 'network_error', message: String(err).slice(0, 200) }, 502, headers);
    }

    if (!geminiResp.ok) {
      const errText = await geminiResp.text().catch(() => '');
      const code = geminiResp.status === 429 ? 'gemini_rate_limit' :
                   geminiResp.status === 400 ? 'gemini_bad_request' :
                   geminiResp.status === 401 || geminiResp.status === 403 ? 'gemini_auth_failed' :
                   'gemini_error';
      return json({ error: code, status: geminiResp.status, detail: errText.slice(0, 400) }, 502, headers);
    }

    let geminiData;
    try { geminiData = await geminiResp.json(); }
    catch { return json({ error: 'gemini_non_json' }, 502, headers); }

    const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      return json({
        error: 'empty_response',
        finishReason: geminiData?.candidates?.[0]?.finishReason || 'unknown'
      }, 502, headers);
    }

    let parsed;
    try { parsed = JSON.parse(rawText); }
    catch {
      return json({ error: 'model_returned_non_json', raw: rawText.slice(0, 500) }, 502, headers);
    }

    // Light shape validation — defensive, don't block a mostly-good response.
    if (!parsed || typeof parsed !== 'object') {
      return json({ error: 'model_returned_non_object' }, 502, headers);
    }
    const participants = Array.isArray(parsed.participants) ? parsed.participants : [];
    const expenses = Array.isArray(parsed.expenses) ? parsed.expenses : [];

    return json({ participants, expenses }, 200, headers);
  }
};
