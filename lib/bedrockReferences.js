const { invokeClaudeMessages, isBedrockConfigured } = require('./bedrockReview');

function stripCodeFences(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  return t;
}

function sanitizeRefFragment(html) {
  return String(html || '')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/ on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .trim();
}

/**
 * @param {Array<{ citation_text?: string, doi?: string, notes?: string, crucible_notes?: string }>} citedSources
 * @param {string} citationStyle
 * @returns {Promise<string>} HTML fragment for Quill (paragraphs / list)
 */
async function formatReferenceListHtml(citedSources, citationStyle) {
  if (!isBedrockConfigured()) {
    const err = new Error('AWS Bedrock is not configured. Set AWS_REGION and a model or inference profile (see docs/aws-bedrock.md).');
    err.code = 'BEDROCK_NOT_CONFIGURED';
    throw err;
  }
  const style = String(citationStyle || 'APA').trim() || 'APA';
  const lines = citedSources.map((s, i) => {
    const cite = s.citation_text != null ? String(s.citation_text).trim() : '';
    const doi = s.doi != null ? String(s.doi).trim() : '';
    const notes = s.notes != null ? String(s.notes).trim() : '';
    const cn = s.crucible_notes != null ? String(s.crucible_notes).trim() : '';
    return [
      `${i + 1}. citation_text: ${cite || '(empty)'}`,
      doi ? `   doi: ${doi}` : '',
      notes ? `   notes: ${notes}` : '',
      cn ? `   crucible_notes: ${cn}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });

  const orderHint =
    style.toUpperCase() === 'IEEE'
      ? 'Number references in the order given below (first row = [1] in IEEE style).'
      : 'Order the reference list appropriately for this style (e.g. alphabetical by author for APA/MLA/Chicago unless the style dictates otherwise).';

  const prompt = `You format academic reference lists for a bibliography section.

Project citation style: ${style}
${orderHint}

The following sources were linked in the user's source manager (Crucible) and detected as cited in the manuscript draft. Use citation_text (and doi/notes when helpful) to produce a proper ${style} reference-list entry for each.

${lines.join('\n\n')}

Output ONLY an HTML fragment suitable for a rich-text editor (no <!DOCTYPE>, no <html>, no <body>).
- For APA, MLA, Chicago, Turabian: use one <p> element per reference entry. Use hanging-indent styling via inline style on each <p> if needed (e.g. style="padding-left:0.5in;text-indent:-0.5in;margin:0 0 0.5em 0") for APA.
- For IEEE: use <ol> with one <li> per entry in the order given.
Do not include markdown code fences. Do not add a centered title line (References / Works Cited / Bibliography); the application prepends that separately—output only the list entries.

Return only the HTML fragment.`;

  const raw = await invokeClaudeMessages(prompt, { maxTokens: 8192, temperature: 0.1 });
  const stripped = stripCodeFences(raw);
  return sanitizeRefFragment(stripped);
}

module.exports = {
  formatReferenceListHtml,
};
