/**
 * Centered, bold heading for the references section body (Quill-friendly HTML).
 * APA & IEEE → "References"; MLA → "Works Cited"; Chicago & Turabian → "Bibliography".
 */
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function referenceSectionHeadingHtml(citationStyle) {
  const st = String(citationStyle || 'APA').toUpperCase();
  let label = 'References';
  if (st === 'MLA') label = 'Works Cited';
  else if (st === 'CHICAGO' || st === 'TURABIAN') label = 'Bibliography';
  // APA, IEEE (and default) → References
  const e = escapeHtml(label);
  return `<p style="text-align:center"><strong>${e}</strong></p><p><br></p>`;
}

module.exports = {
  referenceSectionHeadingHtml,
};
