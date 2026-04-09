"""
Stage 1: decompose a research topic into a structured query plan via Amazon Bedrock (Claude).

Uses the same env vars as the Node app (AWS_REGION, BEDROCK_INFERENCE_PROFILE_ARN, etc.).
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

import boto3

SYSTEM_PROMPT = """You are a research methodology expert specializing in systematic literature review design. Your task is to decompose a research topic into a structured query plan for comprehensive literature retrieval.

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

Be exhaustive with synonyms. Academic disciplines use wildly different terminology for overlapping concepts. A construct that education researchers call "metacognition" might appear as "self-regulated learning" in psychology, "reflective practice" in professional development, or "double-loop learning" in organizational theory. Your synonym expansion is the single most important factor in retrieval quality."""


def trim_bedrock_env(value: str | None) -> str:
    """Trim and strip accidental surrounding quotes from Render / .env paste."""
    if value is None or value == "":
        return ""
    s = str(value).strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    return s


def resolve_bedrock_model_id() -> str:
    """Precedence: BEDROCK_INFERENCE_PROFILE_ARN → BEDROCK_INFERENCE_PROFILE_ID → BEDROCK_MODEL_ID."""
    arn = trim_bedrock_env(os.environ.get("BEDROCK_INFERENCE_PROFILE_ARN"))
    if arn:
        return arn
    profile_id = trim_bedrock_env(os.environ.get("BEDROCK_INFERENCE_PROFILE_ID"))
    if profile_id:
        return profile_id
    return trim_bedrock_env(os.environ.get("BEDROCK_MODEL_ID"))


def is_bedrock_configured() -> bool:
    return bool(trim_bedrock_env(os.environ.get("AWS_REGION")) and resolve_bedrock_model_id())


def build_user_message(
    title: str,
    keywords: list[str],
    project_type: str,
    description: str | None = None,
) -> str:
    msg = f"Research title: {title}\n"
    msg += f"Keywords: {', '.join(keywords)}\n"
    msg += f"Project type: {project_type}\n"
    if description:
        msg += f"Additional context: {description}\n"
    return msg


def _extract_assistant_text(parsed: dict[str, Any]) -> str:
    content = parsed.get("content")
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
                parts.append(str(block["text"]))
        return "\n".join(parts)
    if parsed.get("outputText"):
        return str(parsed["outputText"])
    return ""


def _parse_json_from_model_output(text: str) -> dict[str, Any]:
    """Strip optional markdown fences and parse JSON."""
    t = text.strip()
    fence = re.match(r"^```(?:json)?\s*", t, re.IGNORECASE)
    if fence:
        t = t[fence.end() :]
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3].strip()
    return json.loads(t)


def decompose_research_topic(
    title: str,
    keywords: list[str],
    project_type: str,
    description: str | None = None,
    *,
    max_tokens: int = 8192,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """
    Call Bedrock with the system prompt and a user message built from the inputs.
    Returns the parsed JSON object from the model.
    """
    if not is_bedrock_configured():
        raise ValueError(
            "Bedrock is not configured: set AWS_REGION and one of "
            "BEDROCK_INFERENCE_PROFILE_ARN, BEDROCK_INFERENCE_PROFILE_ID, or BEDROCK_MODEL_ID "
            "(and AWS credentials via default boto3 chain)."
        )

    region = trim_bedrock_env(os.environ.get("AWS_REGION"))
    model_id = resolve_bedrock_model_id()
    user_message = build_user_message(title, keywords, project_type, description)

    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": temperature,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": user_message}],
    }

    client = boto3.client("bedrock-runtime", region_name=region)
    response = client.invoke_model(
        modelId=model_id,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(body),
    )

    raw = response["body"].read().decode("utf-8")
    parsed_response = json.loads(raw)
    assistant_text = _extract_assistant_text(parsed_response)
    if not assistant_text.strip():
        raise ValueError("Empty model response; cannot parse JSON plan.")

    return _parse_json_from_model_output(assistant_text)
