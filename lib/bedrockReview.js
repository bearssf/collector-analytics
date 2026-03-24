const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { htmlToPlainLines } = require('./documentExport');

/** Minimum plain-text length after stripping HTML; below this we skip Bedrock (client can retry after more writing). */
const MIN_DRAFT_PLAIN_CHARS = 15;

/** Trim and strip accidental surrounding quotes from Render / .env paste. */
function trimBedrockEnv(value) {
  if (value == null || value === '') return '';
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * InvokeModel accepts a foundation model id **or** an inference profile id/ARN.
 * Many newer Claude models (e.g. Sonnet 4.x) require an **inference profile** — raw model ids can return
 * "on-demand throughput isn't supported; use an inference profile".
 *
 * Precedence: `BEDROCK_INFERENCE_PROFILE_ARN` → `BEDROCK_INFERENCE_PROFILE_ID` → `BEDROCK_MODEL_ID`.
 * If profile vars are empty, the old foundation model id may still be used and AWS can return "invalid model identifier".
 */
function resolveBedrockModelId() {
  const arnOrEither = trimBedrockEnv(process.env.BEDROCK_INFERENCE_PROFILE_ARN);
  if (arnOrEither) return arnOrEither;
  const profileIdOnly = trimBedrockEnv(process.env.BEDROCK_INFERENCE_PROFILE_ID);
  if (profileIdOnly) return profileIdOnly;
  return trimBedrockEnv(process.env.BEDROCK_MODEL_ID);
}

function isBedrockConfigured() {
  const region = trimBedrockEnv(process.env.AWS_REGION);
  return Boolean(region && resolveBedrockModelId());
}

function draftPlainFromHtml(html) {
  const lines = htmlToPlainLines(html);
  return lines.join('\n\n').trim();
}

function extractAssistantText(parsed) {
  if (parsed.content && Array.isArray(parsed.content)) {
    return parsed.content
      .filter((c) => c && c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  if (parsed.outputText) return String(parsed.outputText);
  return '';
}

/**
 * @param {string} prompt
 * @param {{ maxTokens?: number, temperature?: number }} [opts]
 */
async function invokeClaudeMessages(prompt, opts = {}) {
  const region = trimBedrockEnv(process.env.AWS_REGION);
  const modelId = resolveBedrockModelId();

  const client = new BedrockRuntimeClient({ region });
  const payload = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: opts.maxTokens != null ? opts.maxTokens : 4096,
    temperature: opts.temperature != null ? opts.temperature : 0.2,
    messages: [{ role: 'user', content: prompt }],
  };

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body: Buffer.from(JSON.stringify(payload), 'utf8'),
  });

  const res = await client.send(cmd);
  const raw = Buffer.from(res.body).toString('utf8');
  const parsed = JSON.parse(raw);
  return extractAssistantText(parsed);
}

module.exports = {
  isBedrockConfigured,
  resolveBedrockModelId,
  trimBedrockEnv,
  invokeClaudeMessages,
  draftPlainFromHtml,
  MIN_DRAFT_PLAIN_CHARS,
};
