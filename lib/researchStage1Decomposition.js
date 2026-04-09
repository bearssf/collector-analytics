/**
 * Stage 1 literature retrieval plan via Bedrock (same prompt as stage1_decomposition.py).
 */

const { invokeClaudeWithSystem } = require('./bedrockReview');

const STAGE1_SYSTEM_PROMPT = `You are a research methodology expert specializing in systematic literature review design. Your task is to decompose a research topic into a structured query plan for comprehensive literature retrieval.

You will receive:
- A research title and/or keywords
- A project type: assignment | dissertation | conference | journal

You must return a JSON object with the following structure. Return ONLY valid JSON, no preamble, no markdown fencing.

{
  "core_constructs": [
    {
      "label": "primary term the researcher would use",
      "synonyms": ["alternative terms used in the literature"],
      "broader_terms": ["parent concepts one level up"],
      "narrower_terms": ["more specific sub-concepts"],
      "disciplines": ["fields where this construct appears"]
    }
  ],
  "construct_overlap_flags": [
    {
      "construct_a": "label from core_constructs",
      "construct_b": "label from core_constructs",
      "overlap_description": "explain specifically where these constructs share conceptual territory — shared synonyms, shared narrower terms, co-occurrence in the same theoretical frameworks",
      "recommendation": "merge | keep_distinct",
      "rationale": "why merging or keeping distinct better serves the literature retrieval"
    }
  ],
  "construct_relationships": [
    {
      "construct_a": "label from core_constructs",
      "construct_b": "label from core_constructs",
      "relationship_type": "causal | correlational | moderating | mediating | contextual | unknown",
      "notes": "brief explanation of expected relationship"
    }
  ],
  "methodological_scope": {
    "likely_methods": ["quantitative survey", "qualitative interview", etc.],
    "underrepresented_methods": ["methods rarely applied to this topic"],
    "measurement_instruments": ["known scales or tools used in this domain"]
  },
  "population_scope": {
    "likely_populations": ["who has been studied"],
    "adjacent_populations": ["who could be studied but likely hasn't"],
    "geographic_patterns": ["regions where research concentrates"]
  },
  "temporal_parameters": {
    "foundational_period": "year range for seminal works",
    "active_period": "year range for current conversation",
    "recommended_range": "year range for retrieval"
  },
  "retrieval_queries": [
    {
      "purpose": "what this query targets",
      "openalex_concepts": ["OpenAlex concept IDs or labels to filter by"],
      "keyword_query": "boolean search string for API text search",
      "expected_yield": "rough estimate of papers"
    }
  ],
  "adjacent_fields": [
    {
      "field": "name of adjacent discipline",
      "relevance": "why this field might have relevant work",
      "bridging_terms": ["terms that connect this field to the main topic"]
    }
  ]
}

CONSTRUCT OVERLAP DETECTION:
After generating core_constructs, review every pair for conceptual overlap. Two constructs overlap when they share synonyms, when one construct's narrower terms appear as the other's synonyms, or when the literature frequently treats them as interchangeable. Flag every overlapping pair in construct_overlap_flags. Be aggressive about flagging — false positives are far less costly than missed overlaps, because undetected overlap will corrupt the co-occurrence matrix downstream.

RELATIONSHIP TYPE CLASSIFICATION:
Be rigorous and conservative when assigning relationship_type. Do not default to "causal" unless there is strong theoretical or empirical basis for directional causation. Apply these definitions precisely:
- causal: A is theorized or demonstrated to directly produce changes in B, with a clear directional mechanism. If the direction is merely proposed but not empirically tested, use "unknown" and note the proposed direction in the notes field.
- correlational: A and B tend to co-occur but no directional mechanism has been established.
- moderating: A changes the strength or direction of the relationship between two other constructs.
- mediating: A transmits the effect of one construct on another — it is the mechanism through which the effect operates.
- contextual: A defines the boundary conditions or setting in which other relationships unfold.
- unknown: The relationship is theoretically plausible but the nature and direction have not been established. This should be your most frequently used type. Default to "unknown" rather than "causal" when uncertain.

If a relationship has been proposed as causal in theory but lacks consistent empirical support, classify it as "unknown" and explain the theoretical proposal in the notes field. The gap analysis downstream depends on accurate relationship typing — labeling speculative relationships as causal will cause the system to miss important gaps in empirical evidence.

CALIBRATION BY PROJECT TYPE:
- assignment: 3-5 core constructs, 2-3 retrieval queries, focus on well-established literature, narrower temporal range (last 10 years)
- dissertation: 5-8 core constructs, 5-8 retrieval queries, deep synonym expansion, broad temporal range, must include adjacent fields
- conference: 4-6 core constructs, 3-5 retrieval queries, heavy recency bias (last 3-5 years), emphasis on trending methodologies
- journal: 4-7 core constructs, 4-6 retrieval queries, balanced temporal range, emphasis on theoretical frameworks

Be exhaustive with synonyms. Academic disciplines use wildly different terminology for overlapping concepts. A construct that education researchers call "metacognition" might appear as "self-regulated learning" in psychology, "reflective practice" in professional development, or "double-loop learning" in organizational theory. Your synonym expansion is the single most important factor in retrieval quality.`;

function buildUserMessage(title, keywords, projectType, description) {
  let msg = `Research title: ${title}\n`;
  msg += `Keywords: ${keywords.join(', ')}\n`;
  msg += `Project type: ${projectType}\n`;
  if (description) {
    msg += `Additional context: ${description}\n`;
  }
  return msg;
}

function parseJsonFromModelOutput(text) {
  let t = String(text || '').trim();
  const fence = t.match(/^```(?:json)?\s*/i);
  if (fence) {
    t = t.slice(fence[0].length);
    if (t.trimEnd().endsWith('```')) {
      t = t.trimEnd().slice(0, -3).trim();
    }
  }
  return JSON.parse(t);
}

/**
 * @param {{ title: string, keywords: string[], projectType: string, description?: string | null, maxTokens?: number, temperature?: number }} opts
 * @returns {Promise<object>}
 */
async function runStage1Decomposition(opts) {
  const title = String(opts.title || '').trim();
  const keywords = Array.isArray(opts.keywords) ? opts.keywords.map((k) => String(k).trim()).filter(Boolean) : [];
  const projectType = String(opts.projectType || 'dissertation').trim();
  const description = opts.description != null && String(opts.description).trim() ? String(opts.description).trim() : null;

  if (!title) {
    const err = new Error('Title is required.');
    err.code = 'VALIDATION';
    throw err;
  }
  if (keywords.length === 0) {
    const err = new Error('At least one keyword is required.');
    err.code = 'VALIDATION';
    throw err;
  }

  const userMessage = buildUserMessage(title, keywords, projectType, description);
  const raw = await invokeClaudeWithSystem(STAGE1_SYSTEM_PROMPT, userMessage, {
    maxTokens: opts.maxTokens != null ? opts.maxTokens : 8192,
    temperature: opts.temperature != null ? opts.temperature : 0.2,
  });
  if (!String(raw).trim()) {
    const err = new Error('Empty model response.');
    err.code = 'BEDROCK';
    throw err;
  }
  try {
    return parseJsonFromModelOutput(raw);
  } catch (e) {
    const err = new Error(`Could not parse JSON from model: ${e.message || e}`);
    err.code = 'PARSE';
    throw err;
  }
}

module.exports = {
  STAGE1_SYSTEM_PROMPT,
  buildUserMessage,
  runStage1Decomposition,
};
