// Gemini REST API (streaming). API key sirf server ke env me rehti hai.
const BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Frontend ke 4 model-names -> Gemini model codes.
// Google models badalta rehta hai, isliye .env se override ho sakta hai.
const MODEL_MAP = {
  fast: () => process.env.GEMINI_MODEL_FAST || 'gemini-3.1-flash-lite',
  smart: () => process.env.GEMINI_MODEL_SMART || 'gemini-3.5-flash',
  reasoning: () => process.env.GEMINI_MODEL_REASONING || 'gemini-3.1-pro-preview',
  coding: () => process.env.GEMINI_MODEL_CODING || 'gemini-3.5-flash'
};

const BASE_SYSTEM =
  'You are SquareAI, a helpful, accurate and concise AI assistant. ' +
  'Reply in the same language the user writes in (including Hinglish). ' +
  'Format answers in Markdown. Always put code inside fenced code blocks with a language tag. ' +
  'If you are unsure about something, say so instead of guessing.';

const EXTRA_SYSTEM = {
  coding: ' Focus on correct, production-quality code. Explain briefly, mention edge cases.',
  reasoning: ' Think carefully and show clear step-by-step reasoning when the problem needs it.',
  fast: ' Keep answers short and direct unless the user asks for detail.'
};

class GeminiError extends Error {
  constructor(status, message, userMessage) {
    super(message);
    this.status = status;
    this.userMessage = userMessage;
  }
}

function friendly(status) {
  if (status === 429) return 'AI service is busy right now. Please try again in a minute.';
  if (status === 503 || status === 500) return 'AI service is temporarily unavailable. Please try again.';
  if (status === 400) return 'The AI could not process this request. Try shorter text or a different file.';
  if (status === 401 || status === 403) return 'AI service is not configured correctly. Please contact support.';
  return 'AI request failed. Please try again.';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openStream(model, body, signal) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new GeminiError(503, 'GEMINI_API_KEY missing', 'AI service is not configured yet.');
  const url = `${BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal
    });
    if (res.ok) return res;
    const detail = await res.text().catch(() => '');
    // Ek baar retry: temporary overload
    if ((res.status === 429 || res.status === 503) && attempt === 0) { await sleep(1200); continue; }
    console.error('[gemini] error', res.status, model, detail.slice(0, 500));
    throw new GeminiError(res.status, detail.slice(0, 500), friendly(res.status));
  }
}

/**
 * contents: [{ role: 'user'|'model', parts: [...] }]
 * onText(chunk) har naye text chunk par call hota hai. Return: poora text.
 */
async function streamChat({ modelKey, contents, signal, onText }) {
  const model = (MODEL_MAP[modelKey] || MODEL_MAP.smart)();
  const body = {
    systemInstruction: { parts: [{ text: BASE_SYSTEM + (EXTRA_SYSTEM[modelKey] || '') }] },
    contents,
    generationConfig: { maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS || '8192', 10) }
  };

  const res = await openStream(model, body, signal);
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  let finishReason = null;
  let blockReason = null;

  const handleEvent = (block) => {
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;
    let json;
    try { json = JSON.parse(payload); } catch { return; }
    if (json.promptFeedback && json.promptFeedback.blockReason) blockReason = json.promptFeedback.blockReason;
    const cand = json.candidates && json.candidates[0];
    if (!cand) return;
    if (cand.finishReason) finishReason = cand.finishReason;
    const parts = (cand.content && cand.content.parts) || [];
    for (const p of parts) {
      if (p.thought) continue;                       // internal thinking user ko nahi dikhana
      if (typeof p.text === 'string' && p.text) { full += p.text; onText(p.text); }
    }
  };

  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      handleEvent(buf.slice(0, idx));
      buf = buf.slice(idx + 2);
    }
  }
  if (buf.trim()) handleEvent(buf);

  if (!full) {
    if (blockReason || finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT') {
      throw new GeminiError(200, 'blocked', 'This request was blocked by the AI safety filters. Please rephrase it.');
    }
    throw new GeminiError(200, 'empty response', 'The AI returned an empty response. Please try again.');
  }
  return { text: full, finishReason };
}

module.exports = { streamChat, GeminiError };
