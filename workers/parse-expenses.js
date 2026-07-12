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

const SYSTEM_PROMPT = `You are an expense-splitting assistant. Extract participants and expenses from natural-language text about group spending (dinners, trips, roommate bills, etc.), then output STRICT JSON matching the schema below.

Output format (JSON only, no markdown code fences, no prose before/after):
{
  "participants": [ { "name": "string" } ],
  "expenses": [
    {
      "payer": "string (a participant name, exactly as spelled in participants)",
      "amount": number,
      "description": "string",
      "sharedBy": [ "string (participant names)" ],
      "confidence": "high" | "medium" | "low",
      "note": "string, optional — only include if you had to guess"
    }
  ]
}

Extraction rules:
- Every named person mentioned becomes a participant. If someone appears only in a "sharedBy" (e.g. "split with Bob") but is never a payer, still include them in participants.
- "Alice and Bob split dinner \$80" → one expense, amount 80, payer = Alice (first named), sharedBy = ["Alice","Bob"], confidence "medium", note explaining the payer assumption.
- "Everyone paid their share" / "we all split X" → sharedBy = all participants, confidence "medium", note = "no single payer specified".
- "Alice paid \$50 for dinner" → payer = "Alice", amount = 50, sharedBy defaults to all participants unless the text says otherwise. If it does not specify sharedBy at all, default to all participants and set confidence "medium".
- Currency symbols (\$, NT\$, ¥, €, £) are stripped; keep only the numeric value.
- Numbers with thousands separators ("1,200") become 1200.
- If a row's amount is missing or unparseable, SKIP that row entirely — do not emit it.
- Support English and Traditional/Simplified Chinese input equally.
- Preserve original names (do not translate names or normalize case unless the text is clearly ALL CAPS).
- Descriptions should be short (≤ 60 chars). Keep the original language.

Ambiguity handling:
- Prefer confidence "low" over hallucinating. If unsure, still emit the row but mark it low and explain in note.
- Never invent participants. Only names that literally appear in the text.
- Never invent amounts. Only numbers that literally appear in the text.
- If the entire input is not about expenses (e.g. random chat), return {"participants":[],"expenses":[]}.`;

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

    const userPrompt = hint
      ? `Additional context: ${hint}\n\nText to parse:\n${text}`
      : `Text to parse:\n${text}`;

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
