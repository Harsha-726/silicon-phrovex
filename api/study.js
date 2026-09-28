import { createHash } from 'node:crypto';
import { ensureProfile, requireClerkUser, supabaseRequest, json } from './_auth.js';

const MAX_HARD_INPUT_TOKENS = 500_000;
const MAX_HARD_OUTPUT_TOKENS = 8_000;
const MAX_HARD_CONTENT_CHARS = 250_000;
const claimTimeoutMs = 10 * 60 * 1000;

function bodyOf(request) {
  if (request.body && typeof request.body === 'object') return request.body;
  if (typeof request.body === 'string') { try { return JSON.parse(request.body); } catch { return {}; } }
  return {};
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  return value === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function integerEnv(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

function estimateTokens(value) { return Math.ceil(String(value).length / 3.5) + 500; }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function canonical(value) { return JSON.stringify(value, Object.keys(value || {}).sort()); }
function geminiModel(kind, fallback = false) {
  if (kind === 'sonnet') return process.env.GEMINI_PRO_MODEL || 'gemini-2.5-pro';
  return fallback ? (process.env.GEMINI_FLASH_FALLBACK_MODEL || 'gemini-3.5-flash-lite') : (process.env.GEMINI_FLASH_MODEL || 'gemini-3.6-flash');
}
function activeSubscription(row) { return ['active', 'trialing'].includes(row?.status); }
function studyPlan(row) { return activeSubscription(row) && ['student', 'advanced'].includes(row?.plan) ? row.plan : 'free'; }
function studyLimits(subscription) {
  const plan = studyPlan(subscription);
  if (plan === 'advanced') return { plan, basicGenerations: integerEnv('STUDY_ADVANCED_BASIC_MONTHLY_LIMIT', 60, 0, 60), advancedGenerations: integerEnv('STUDY_ADVANCED_ADVANCED_MONTHLY_LIMIT', 20, 0, 20), monthlyInputTokens: integerEnv('STUDY_ADVANCED_MAX_INPUT_TOKENS', 100_000, 1_000, MAX_HARD_INPUT_TOKENS), dailyRequests: integerEnv('STUDY_ADVANCED_DAILY_REQUEST_LIMIT', 20, 0, 20), monthlyCostCents: integerEnv('STUDY_ADVANCED_MONTHLY_COST_CENTS', 2500, 0, 2500), globalCostCents: integerEnv('STUDY_GLOBAL_MONTHLY_COST_CENTS', 10000, 0, 25000) };
  if (plan === 'student') return { plan, basicGenerations: integerEnv('STUDY_BASIC_MONTHLY_LIMIT', 25, 0, 25), advancedGenerations: integerEnv('STUDY_ADVANCED_MONTHLY_LIMIT', 5, 0, 5), monthlyInputTokens: integerEnv('STUDY_MAX_INPUT_TOKENS', 50_000, 1_000, MAX_HARD_INPUT_TOKENS), dailyRequests: integerEnv('STUDY_DAILY_REQUEST_LIMIT', 10, 0, 20), monthlyCostCents: integerEnv('STUDY_MONTHLY_COST_CENTS', 1000, 0, 2500), globalCostCents: integerEnv('STUDY_GLOBAL_MONTHLY_COST_CENTS', 10000, 0, 25000) };
  return { plan: 'free', basicGenerations: integerEnv('STUDY_FREE_BASIC_MONTHLY_LIMIT', 10, 0, 10), advancedGenerations: integerEnv('STUDY_FREE_ADVANCED_MONTHLY_LIMIT', 0, 0, 0), monthlyInputTokens: integerEnv('STUDY_FREE_MAX_INPUT_TOKENS', 100_000, 1_000, MAX_HARD_INPUT_TOKENS), dailyRequests: integerEnv('STUDY_FREE_DAILY_REQUEST_LIMIT', 3, 0, 3), monthlyCostCents: integerEnv('STUDY_FREE_MONTHLY_COST_CENTS', 200, 0, 2500), globalCostCents: integerEnv('STUDY_GLOBAL_MONTHLY_COST_CENTS', 10000, 0, 25000) };
}

const STUDY_SOURCE_BLOCK_CHARS = 1800;

function splitTextIntoBlocks(content) {
  const blocks = [];
  let current = '';
  const flush = () => {
    const text = current.trim();
    if (text) blocks.push({ id: `S${blocks.length + 1}`, label: `Source section ${blocks.length + 1}`, text });
    current = '';
  };
  for (const paragraph of String(content).split(/\n{2,}/)) {
    const value = paragraph.trim();
    if (!value) continue;
    if (value.length > STUDY_SOURCE_BLOCK_CHARS) {
      flush();
      for (let offset = 0; offset < value.length; offset += STUDY_SOURCE_BLOCK_CHARS) {
        const slice = value.slice(offset, offset + STUDY_SOURCE_BLOCK_CHARS).trim();
        if (slice) blocks.push({ id: `S${blocks.length + 1}`, label: `Source section ${blocks.length + 1}`, text: slice });
      }
      continue;
    }
    if (current && current.length + value.length + 2 > STUDY_SOURCE_BLOCK_CHARS) flush();
    current = current ? `${current}\n\n${value}` : value;
  }
  flush();
  return blocks.length ? blocks : [{ id: 'S1', label: 'Source section 1', text: String(content).trim() }];
}

function sourceBlocksFor(content, sourcePages) {
  const pages = Array.isArray(sourcePages?.pages) && sourcePages.contentLength === content.length
    ? sourcePages.pages.filter(page => Number.isInteger(page?.start) && Number.isInteger(page?.end) && page.end > page.start && page.start >= 0 && page.end <= content.length)
      .sort((a, b) => a.start - b.start)
      .map((page, index) => ({ id: `P${index + 1}`, label: `Page ${page.page || index + 1}`, text: content.slice(page.start, page.end).trim() }))
      .filter(page => page.text)
    : [];
  return pages.length ? pages : splitTextIntoBlocks(content);
}

function normalizeRequest(input) {
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 160) : 'Untitled study material';
  const requestedFormat = input.format === 'outline' ? 'study_guide' : input.format;
  const format = ['flashcards', 'quiz', 'summary', 'study_guide'].includes(requestedFormat) ? requestedFormat : 'flashcards';
  const model = input.model === 'sonnet' ? 'sonnet' : 'haiku';
  const sourceType = ['text', 'file', 'transcript'].includes(input.source_type) ? input.source_type : 'text';
  const difficulty = ['easy', 'medium', 'hard'].includes(input.options?.difficulty) ? input.options.difficulty : 'medium';
  const count = Math.min(50, Math.max(5, Math.round(Number(input.options?.count) || 20)));
  const length = ['short', 'standard', 'detailed'].includes(input.options?.length) ? input.options.length : 'standard';
  if (!content) throw new Error('Add some study material first');
  if (content.length > MAX_HARD_CONTENT_CHARS) throw new Error('This material is too large. Split it into smaller sections first.');
  const sourcePages = input.source_pages && typeof input.source_pages === 'object' ? input.source_pages : null;
  return { title, content, format, model, sourceType, sourcePages, sourceBlocks: sourceBlocksFor(content, sourcePages), options: { difficulty, count, length }, inputTokens: estimateTokens(content) };
}

function outputLimit(request) {
  const configured = integerEnv('STUDY_MAX_OUTPUT_TOKENS', 4_000, 500, MAX_HARD_OUTPUT_TOKENS);
  if (request.format === 'summary') return Math.min(configured, request.options.length === 'detailed' ? 4_000 : 2_500);
  if (request.format === 'study_guide') return Math.min(configured, 3_500);
  return Math.min(configured, request.options.count * (request.format === 'quiz' ? 130 : 90) + 300);
}

function estimatedCostCents(model, inputTokens, outputTokens) {
  const inputRate = model === 'sonnet' ? 2 : 1;
  const outputRate = model === 'sonnet' ? 10 : 5;
  return Math.max(1, Math.ceil((inputTokens * inputRate + outputTokens * outputRate) / 10_000));
}

function instructions(request) {
  const formatInstructions = {
    flashcards: `Return {"type":"flashcards","cards":[{"front":"...","back":"..."}]} with exactly ${request.options.count} high-yield cards. Each card should test one idea, use active recall, and have a concise answer.`,
    quiz: `Return {"type":"quiz","questions":[{"question":"...","choices":["...","...","..."],"correctChoice":0,"explanation":"..."}]} with exactly ${request.options.count} questions. Use plausible distractors supported by the material or clearly incompatible with it; never invent outside facts.`,
    summary: 'Return {"type":"summary","title":"...","keyPoints":["..."],"summary":"...","terms":[{"term":"...","definition":"..."}]} with a concise, exam-useful summary and only source-supported terms.',
    study_guide: 'Return {"type":"study_guide","title":"...","sections":[{"heading":"...","points":["..."]}]} as a clear hierarchical outline that moves from core ideas to supporting details. Do not include questions, flashcards, cards, quizzes, answer prompts, or any other practice items.'
  };
  return `You are a strict study-material production team with four roles: (1) a source curator who extracts concepts, definitions, processes, examples, contrasts, formulas, and likely misconceptions; (2) a retrieval-practice coach who favors recall, discrimination, and transfer over copying; (3) a skeptical verifier who checks every generated claim against the supplied material; and (4) a clear teacher who organizes the result for a student preparing for an assessment.\n\nNon-negotiable rules:\n- Use only the supplied material. Do not use general knowledge to fill gaps, even when you are confident.\n- Preserve important qualifiers, exceptions, units, dates, names, and cause/effect direction.\n- Prefer high-yield concepts and relationships over trivia or filler.\n- Do not make multiple cards or questions that test the same fact in slightly different words.\n- If the material is incomplete, ambiguous, or internally inconsistent, say so briefly in the artifact instead of guessing.\n- Cite the source block IDs that support each card, question, or outline section in a sourceRefs array. For summaries, include evidence entries with sourceRefs and a short exact quote. Never invent a source ID or cite a block that does not support the claim.\n- Return valid JSON only. No Markdown fences, commentary, citations, or extra keys.\n\nAvailable source blocks: ${request.sourceBlocks.map(block => `${block.id} (${block.label})`).join(', ')}\n\nDifficulty: ${request.options.difficulty}. ${formatInstructions[request.format]}`;
}

function responseSchema(request) {
  const text = { type: 'string' };
  const type = { type: 'string', enum: [request.format] };
  const sourceRefs = { type: 'array', items: { type: 'string' } };
  const evidence = { type: 'array', items: { type: 'object', properties: { sourceRefs, quote: text }, required: ['sourceRefs', 'quote'] } };
  if (request.format === 'flashcards') return {
    type: 'object',
    properties: { type, cards: { type: 'array', items: { type: 'object', properties: { front: text, back: text, sourceRefs }, required: ['front', 'back', 'sourceRefs'] } }, evidence },
    required: ['type', 'cards']
  };
  if (request.format === 'quiz') return {
    type: 'object',
    properties: {
      type,
      questions: { type: 'array', items: { type: 'object', properties: { question: text, choices: { type: 'array', items: text }, correctChoice: { type: 'integer' }, explanation: text, sourceRefs }, required: ['question', 'choices', 'correctChoice', 'sourceRefs'] } },
      evidence
    },
    required: ['type', 'questions']
  };
  if (request.format === 'summary') return {
    type: 'object',
    properties: { type, title: text, keyPoints: { type: 'array', items: text }, summary: text, terms: { type: 'array', items: { type: 'object', properties: { term: text, definition: text }, required: ['term', 'definition'] } }, evidence },
    required: ['type', 'keyPoints', 'summary']
  };
  return {
    type: 'object',
    properties: { type, title: text, sections: { type: 'array', items: { type: 'object', properties: { heading: text, points: { type: 'array', items: text }, sourceRefs }, required: ['heading', 'points', 'sourceRefs'] } }, evidence },
    required: ['type', 'sections']
  };
}

function sourceRefSet(request) { return new Set(request.sourceBlocks.map(block => block.id)); }

function inferredSourceRefs(request, value) {
  const terms = new Set(String(value || '').toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || []);
  if (!terms.size) return [];
  return request.sourceBlocks.map(block => {
    const blockTerms = new Set(block.text.toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) || []);
    const overlap = [...terms].filter(term => blockTerms.has(term)).length;
    return { id: block.id, score: overlap / terms.size };
  }).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).map(item => item.id);
}

function normalizedSourceRefs(request, refs, fallbackText) {
  const known = sourceRefSet(request);
  const explicit = Array.isArray(refs) ? [...new Set(refs.map(ref => String(ref)).filter(ref => known.has(ref)))] : [];
  return explicit.length ? explicit : inferredSourceRefs(request, fallbackText);
}

function sourceMap(request) { return request.sourceBlocks.map(({ id, label }) => ({ id, label })); }

function normalizedEvidence(request, evidence) {
  if (!Array.isArray(evidence)) return [];
  return evidence.map(item => ({ sourceRefs: normalizedSourceRefs(request, item?.sourceRefs, item?.quote), quote: String(item?.quote || '').trim() })).filter(item => item.sourceRefs.length && item.quote).slice(0, 12);
}

function parseJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try { return JSON.parse(cleaned); } catch {
    // Structured output should already be a complete JSON object. Keep this
    // narrow recovery for a model that adds a short preamble or trailing note,
    // but never accept an arbitrary non-object response.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* report the contract error below */ }
    }
    throw new Error('Gemini returned an invalid study format. Please try again.');
  }
}

function validateArtifact(request, artifact) {
  const { format } = request;
  if (!artifact || artifact.type !== format) throw new Error('Gemini returned the wrong study format. Please try again.');
  const base = { ...artifact, sourceMap: sourceMap(request), evidence: normalizedEvidence(request, artifact.evidence) };
  if (format === 'flashcards' && (!Array.isArray(artifact.cards) || !artifact.cards.length || artifact.cards.some(card => !card?.front || !card?.back))) throw new Error('Gemini returned incomplete flashcards. Please try again.');
  if (format === 'flashcards') base.cards = artifact.cards.map(card => ({ ...card, sourceRefs: normalizedSourceRefs(request, card.sourceRefs, `${card.front} ${card.back}`) }));
  if (format === 'quiz' && (!Array.isArray(artifact.questions) || !artifact.questions.length || artifact.questions.some(question => !question?.question || !Array.isArray(question.choices) || question.choices.length < 2 || !Number.isInteger(question.correctChoice) || question.correctChoice < 0 || question.correctChoice >= question.choices.length))) throw new Error('Gemini returned an incomplete quiz. Please try again.');
  if (format === 'quiz') base.questions = artifact.questions.map(question => ({ ...question, sourceRefs: normalizedSourceRefs(request, question.sourceRefs, `${question.question} ${question.choices.join(' ')}`) }));
  if (format === 'summary' && (!artifact.summary || !Array.isArray(artifact.keyPoints))) throw new Error('Gemini returned an incomplete summary. Please try again.');
  if (format === 'study_guide') {
    if (!Array.isArray(artifact.sections) || !artifact.sections.length) throw new Error('Gemini returned an incomplete outline. Please try again.');
    const sections = artifact.sections.filter(section => section && typeof section === 'object').map(section => ({ heading: String(section.heading || 'Section'), points: Array.isArray(section.points) ? section.points.map(point => String(point)).filter(Boolean) : [], sourceRefs: normalizedSourceRefs(request, section.sourceRefs, `${section.heading || ''} ${(section.points || []).join(' ')}`) }));
    if (!sections.length) throw new Error('Gemini returned an incomplete outline. Please try again.');
    return { ...base, type: 'study_guide', title: String(artifact.title || 'Study guide'), sections };
  }
  return base;
}

async function callGemini(request, maxTokens, modelOverride = '') {
  if (!process.env.GEMINI_API_KEY) throw new Error('Study generation is not configured yet. Add the Gemini API key on the server.');
  const model = modelOverride || geminiModel(request.model);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    signal: AbortSignal.timeout(50_000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: instructions(request) }] },
      contents: [{ role: 'user', parts: [{ text: `Study material titled “${request.title}”. Use only these labeled source blocks:\n\n${request.sourceBlocks.map(block => `[${block.id} | ${block.label}]\n${block.text}`).join('\n\n')}` }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens, responseMimeType: 'application/json', responseSchema: responseSchema(request) }
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload?.error?.message || 'Study generation failed'); error.status = response.status; throw error; }
  const text = payload?.candidates?.[0]?.content?.parts?.filter(part => typeof part.text === 'string').map(part => part.text).join('') || '';
  if (!text) throw new Error(payload?.promptFeedback?.blockReason ? `Gemini blocked this material (${payload.promptFeedback.blockReason}). Please remove sensitive or unsafe content and try again.` : 'Gemini returned no study material. Please try again.');
  try {
    return { artifact: validateArtifact(request, parseJson(text)), inputTokens: Number(payload.usageMetadata?.promptTokenCount) || request.inputTokens, outputTokens: Number(payload.usageMetadata?.candidatesTokenCount) || 0 };
  } catch (error) {
    // Invalid model output is an upstream contract failure, not an internal
    // application exception. The outer handler can return a useful 502 while
    // the caller's reserved usage is released by the surrounding transaction.
    if (!error.status) error.status = 502;
    error.code ||= 'INVALID_MODEL_OUTPUT';
    throw error;
  }
}

async function callGeminiWithFallback(request, maxTokens) {
  try {
    return await callGemini(request, maxTokens);
  } catch (error) {
    const fallback = geminiModel(request.model, true);
    if (request.model !== 'sonnet' && error.status === 503 && fallback !== geminiModel(request.model)) return callGemini(request, maxTokens, fallback);
    throw error;
  }
}

async function findMaterial(userId, contentHash) {
  const rows = await supabaseRequest(`study_materials?user_id=eq.${encodeURIComponent(userId)}&content_hash=eq.${encodeURIComponent(contentHash)}&select=*&limit=1`);
  return rows?.[0] || null;
}

async function findArtifact(userId, cacheKey) {
  const rows = await supabaseRequest(`study_artifacts?user_id=eq.${encodeURIComponent(userId)}&cache_key=eq.${encodeURIComponent(cacheKey)}&select=*&limit=1`);
  return rows?.[0] || null;
}
async function subscriptionFor(userId) {
  const rows = await supabaseRequest(`billing_subscriptions?user_id=eq.${encodeURIComponent(userId)}&select=plan,status,current_period_end,cancel_at_period_end&limit=1`);
  return rows?.[0] || null;
}

async function claimArtifact(userId, request, materialId, cacheKey) {
  const record = { user_id: userId, material_id: materialId, cache_key: cacheKey, format: request.format, model: request.model, options: request.options, status: 'processing', claimed_at: new Date().toISOString() };
  try {
    const rows = await supabaseRequest('study_artifacts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([record]) });
    return { artifact: rows?.[0], claimed: true };
  } catch (error) {
    if (error.status !== 409 && error.body?.code !== '23505') throw error;
    const existing = await findArtifact(userId, cacheKey);
    if (existing?.status === 'completed') return { artifact: existing, claimed: false };
    if (existing?.status === 'processing' && Date.now() - Date.parse(existing.claimed_at || existing.updated_at || existing.created_at || '') < claimTimeoutMs) return { artifact: existing, claimed: false, busy: true };
    const rows = await supabaseRequest(`study_artifacts?id=eq.${encodeURIComponent(existing.id)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'processing', usage_released_at: null, error_message: null, claimed_at: new Date().toISOString(), updated_at: new Date().toISOString() }) });
    return { artifact: rows?.[0] || existing, claimed: true };
  }
}

async function markArtifact(userId, id, patch) {
  return supabaseRequest(`study_artifacts?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) });
}

function usagePayload(row) {
  const today = new Date().toISOString().slice(0, 10);
  const requestDay = row?.request_day ? String(row.request_day).slice(0, 10) : today;
  const requestsToday = requestDay === today ? Number(row.requests_today || 0) : 0;
  return { periodStart: row?.period_start || new Date().toISOString().slice(0, 7) + '-01', basicGenerations: row?.basic_generations || 0, advancedGenerations: row?.advanced_generations || 0, inputTokens: row?.input_tokens || 0, reservedCostCents: row?.reserved_cost_cents || 0, requestsToday };
}

function currentStudyPeriod() {
  const month = new Date();
  month.setUTCDate(1);
  return month.toISOString().slice(0, 10);
}

// Keep already-deployed databases correct even before the latest reservation
// function migration is applied. The stale-day filter makes this safe when
// two requests cross the daily boundary at the same time.
async function resetDailyStudyUsage(userId, period = currentStudyPeriod()) {
  const today = new Date().toISOString().slice(0, 10);
  const filter = `user_id=eq.${encodeURIComponent(userId)}&period_start=eq.${period}`;
  const rows = await supabaseRequest(`study_usage_monthly?${filter}&select=*&limit=1`);
  const row = rows?.[0];
  if (!row || String(row.request_day || '').slice(0, 10) === today) return row;
  const updated = await supabaseRequest(`study_usage_monthly?${filter}&request_day=neq.${today}`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ requests_today: 0, request_day: today }) });
  return updated?.[0] || { ...row, requests_today: 0, request_day: today };
}

async function releaseStudyUsage(userId, artifactId, generationKind, inputTokens, estimatedCostCents) {
  return supabaseRequest('rpc/release_study_usage', {
    method: 'POST',
    body: JSON.stringify({
      p_user_id: userId,
      p_artifact_id: artifactId,
      p_generation_kind: generationKind,
      p_input_tokens: inputTokens,
      p_estimated_cost_cents: estimatedCostCents
    })
  });
}

export default async function handler(request, response) {
  const auth = await requireClerkUser(request, response);
  if (auth.error) return auth.error;
  response.setHeader('Cache-Control', 'no-store');
  try {
    if (request.method === 'GET') {
      const period = currentStudyPeriod();
      const subscription = await subscriptionFor(auth.userId);
      const materialId = request.query?.material_id;
      const materialIdFilter = materialId && /^[0-9a-f-]{36}$/i.test(materialId) ? `&id=eq.${encodeURIComponent(materialId)}` : '';
      const materialSelect = materialIdFilter ? 'id,title,source_type,token_count,created_at,content' : 'id,title,source_type,token_count,created_at';
      const artifactMaterialFilter = materialIdFilter ? `&material_id=eq.${encodeURIComponent(materialId)}` : '';
      const [materials, usage, artifacts] = await Promise.all([
        supabaseRequest(`study_materials?user_id=eq.${encodeURIComponent(auth.userId)}${materialIdFilter}&select=${materialSelect}&order=created_at.desc&limit=50`),
        resetDailyStudyUsage(auth.userId, period),
        supabaseRequest(`study_artifacts?user_id=eq.${encodeURIComponent(auth.userId)}${artifactMaterialFilter}&status=eq.completed&select=id,material_id,format,model,options,status,content_json,created_at,updated_at&order=created_at.desc&limit=100`)
      ]);
      const limits = studyLimits(subscription);
      const materialTitles = new Map((materials || []).map(material => [material.id, material.title]));
      const history = (artifacts || []).map(artifact => ({ ...artifact, material_title: materialTitles.get(artifact.material_id) || 'Study material' }));
      return json(response, 200, { enabled: boolEnv('STUDY_AI_ENABLED'), materials: materials || [], artifacts: history, usage: usagePayload(usage?.[0]), billing: { plan: limits.plan, status: subscription?.status || 'inactive', currentPeriodEnd: subscription?.current_period_end || null, cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end) }, limits });
    }
    if (request.method !== 'POST') return json(response, 405, { error: 'Method not allowed' });
    const subscription = await subscriptionFor(auth.userId);
    const limits = studyLimits(subscription);
    if (!boolEnv('STUDY_AI_ENABLED')) return json(response, 503, { error: 'Study generation is disabled until it is enabled on the server.' });
    if (!process.env.GEMINI_API_KEY) return json(response, 503, { error: 'Study generation is not configured yet. Add the Gemini API key on the server.' });
    const parsed = normalizeRequest(bodyOf(request));
    if (parsed.model === 'sonnet' && limits.advancedGenerations < 1) return json(response, 402, { error: 'Sonnet generations are available on the Student and Advanced plans.', code: 'PLAN_UPGRADE_REQUIRED' });
    const maxInputTokens = limits.monthlyInputTokens;
    if (parsed.inputTokens > maxInputTokens) return json(response, 413, { error: `This material is too large. The current limit is ${maxInputTokens.toLocaleString()} estimated tokens.` });
    await ensureProfile(auth.userId);
    await resetDailyStudyUsage(auth.userId);
    const contentHash = hash(parsed.content);
    const material = await findMaterial(auth.userId, contentHash) || (await supabaseRequest('study_materials', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=representation' }, body: JSON.stringify([{ user_id: auth.userId, title: parsed.title, source_type: parsed.sourceType, content: parsed.content, content_hash: contentHash, token_count: parsed.inputTokens }]) }))[0];
    // Grounded artifacts have a different contract (source refs/evidence) than
    // the original ungrounded responses, so never serve an older cached shape.
    const cacheVersion = 'grounded-v1';
    const cacheKey = hash(`${cacheVersion}:${contentHash}:${parsed.format}:${parsed.model}:${canonical(parsed.options)}`);
    const claim = await claimArtifact(auth.userId, parsed, material.id, cacheKey);
    if (!claim.claimed) {
      if (claim.busy) return json(response, 409, { error: 'This study set is already being generated. Please wait a moment.' });
      return json(response, 200, { artifact: claim.artifact, cached: true });
    }
    const maxOutputTokens = outputLimit(parsed);
    const estimatedCost = estimatedCostCents(parsed.model, parsed.inputTokens, maxOutputTokens);
    const reservation = await supabaseRequest('rpc/reserve_study_usage', { method: 'POST', body: JSON.stringify({ p_user_id: auth.userId, p_generation_kind: parsed.model === 'sonnet' ? 'advanced' : 'basic', p_input_tokens: parsed.inputTokens, p_estimated_cost_cents: estimatedCost, p_max_basic: limits.basicGenerations, p_max_advanced: limits.advancedGenerations, p_max_input_tokens: maxInputTokens, p_max_user_cost_cents: limits.monthlyCostCents, p_max_daily_requests: limits.dailyRequests, p_max_global_cost_cents: limits.globalCostCents }) });
    const gate = Array.isArray(reservation) ? reservation[0] : reservation;
    if (!gate?.allowed) {
      await markArtifact(auth.userId, claim.artifact.id, { status: 'failed', error_message: gate?.reason || 'Study generation limit reached' });
      return json(response, 429, { error: gate?.reason || 'Study generation limit reached', usage: usagePayload(gate) });
    }
    try {
      const result = await callGeminiWithFallback(parsed, maxOutputTokens);
      const rows = await markArtifact(auth.userId, claim.artifact.id, { status: 'completed', content_json: result.artifact, input_tokens: result.inputTokens, output_tokens: result.outputTokens, reserved_cost_cents: estimatedCost, error_message: null });
      return json(response, 200, { artifact: rows?.[0] || { ...claim.artifact, status: 'completed', content_json: result.artifact }, cached: false, usage: gate });
    } catch (error) {
      await releaseStudyUsage(auth.userId, claim.artifact.id, parsed.model === 'sonnet' ? 'advanced' : 'basic', parsed.inputTokens, estimatedCost).catch((releaseError) => {
        console.error('Study usage release failed', { artifactId: claim.artifact.id, status: releaseError?.status || 0 });
      });
      await markArtifact(auth.userId, claim.artifact.id, { status: 'failed', error_message: error.message?.slice(0, 500) || 'Study generation failed' }).catch(() => {});
      throw error;
    }
  } catch (error) {
    const status = error.status === 429 || error.status === 503 ? error.status : error.status >= 400 && error.status < 500 ? error.status : 500;
    return json(response, status, { error: error.message || 'Study generation failed' });
  }
}
