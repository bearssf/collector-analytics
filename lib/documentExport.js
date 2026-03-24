const { Document, Packer, Paragraph, TextRun, HeadingLevel, LineRuleType } = require('docx');

/**
 * Detect Quill Delta JSON stored in project_sections.body (Anvil canonical format).
 */
function isQuillDeltaJson(s) {
  const t = String(s || '').trim();
  return t.length > 0 && t.charAt(0) === '{' && /"ops"\s*:\s*\[/.test(t);
}

function isAnvilMsHtmlJson(s) {
  const t = String(s || '').trim();
  if (t.length === 0 || t.charAt(0) !== '{') return false;
  try {
    const o = JSON.parse(t);
    return !!(o && o._anvil === 'mshtml' && o.html != null);
  } catch (e) {
    return false;
  }
}

/**
 * Plain lines from stored section body: Quill Delta JSON or legacy HTML.
 */
function plainLinesFromSectionBody(stored) {
  if (stored == null || !String(stored).trim()) return [];
  const s = String(stored).trim();
  if (isAnvilMsHtmlJson(s)) {
    try {
      const o = JSON.parse(s);
      return htmlToPlainLines(String(o.html || ''));
    } catch (e) {
      return [];
    }
  }
  if (isQuillDeltaJson(s)) {
    try {
      const o = JSON.parse(s);
      let text = '';
      for (const op of o.ops || []) {
        if (typeof op.insert === 'string') {
          text += op.insert;
        } else if (op.insert && typeof op.insert === 'object') {
          text += '\n';
        }
      }
      return text
        .split(/\n+/)
        .map((x) => x.trim())
        .filter(Boolean);
    } catch (e) {
      return [];
    }
  }
  return htmlToPlainLines(s);
}

/**
 * Strip Quill/HTML to plain lines for .txt / .docx.
 */
function htmlToPlainLines(html) {
  if (html == null || !String(html).trim()) return [];
  let s = String(html);
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/h[1-6][^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = s.replace(/&nbsp;/g, ' ');
  s = s.replace(/&amp;/g, '&');
  s = s.replace(/&lt;/g, '<');
  s = s.replace(/&gt;/g, '>');
  s = s.replace(/&#39;/g, "'");
  s = s.replace(/&quot;/g, '"');
  return s
    .split(/\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function normalizePlainCitationLine(line) {
  let t = String(line || '');
  t = t.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\[\s*(\d{1,3})\s*\]/g, '[$1]');
  t = t.replace(/\(([^)]*)\)/g, function (_m, inner) {
    return '(' + inner.replace(/\s{2,}/g, ' ').trim() + ')';
  });
  return t;
}

function lineSpacingForCitationStyle(citationStyle) {
  const s = String(citationStyle || 'APA').toUpperCase();
  if (s === 'IEEE') {
    return { line: 276, lineRule: LineRuleType.AUTO };
  }
  return { line: 480, lineRule: LineRuleType.AUTO };
}

function textRunOptionsForCitationStyle(citationStyle) {
  const s = String(citationStyle || 'APA').toUpperCase();
  if (s === 'IEEE') {
    return { font: 'Times New Roman', size: 20 };
  }
  return { font: 'Times New Roman', size: 24 };
}

function sanitizeFilename(name) {
  const base = String(name || 'export')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return base || 'export';
}

function buildPlainTextForProject(projectName, sections) {
  const lines = [];
  lines.push(String(projectName || 'Project'));
  lines.push('');
  (sections || []).forEach(function (sec) {
    lines.push(String(sec.title || 'Section'));
    lines.push('');
    plainLinesFromSectionBody(sec.body).forEach(function (line) {
      lines.push(normalizePlainCitationLine(line));
    });
    lines.push('');
  });
  return lines.join('\n').trim() + '\n';
}

function paragraphChildrenFromHtml(html, citationStyle) {
  const cs = citationStyle != null ? String(citationStyle) : 'APA';
  const spacing = lineSpacingForCitationStyle(cs);
  const trOpts = textRunOptionsForCitationStyle(cs);
  const lines = htmlToPlainLines(html);
  if (!lines.length) {
    return [
      new Paragraph({
        spacing,
        children: [new TextRun({ text: '', ...trOpts })],
      }),
    ];
  }
  return lines.map(function (line) {
    return new Paragraph({
      spacing,
      children: [new TextRun({ text: normalizePlainCitationLine(line), ...trOpts })],
    });
  });
}

async function buildSectionDocxBuffer({ title, html, citationStyle }) {
  const cs = citationStyle != null ? String(citationStyle) : 'APA';
  const trOpts = textRunOptionsForCitationStyle(cs);
  const heading = String(title || 'Section').trim() || 'Section';
  const bodyChildren = paragraphChildrenFromHtml(html, cs);
  const children = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: heading, ...trOpts })],
    }),
    ...bodyChildren,
  ];
  const doc = new Document({
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

function paragraphChildrenFromSectionBody(storedBody, citationStyle) {
  const cs = citationStyle != null ? String(citationStyle) : 'APA';
  const spacing = lineSpacingForCitationStyle(cs);
  const trOpts = textRunOptionsForCitationStyle(cs);
  const lines = plainLinesFromSectionBody(storedBody);
  if (!lines.length) {
    return [
      new Paragraph({
        spacing,
        children: [new TextRun({ text: '', ...trOpts })],
      }),
    ];
  }
  return lines.map(function (line) {
    return new Paragraph({
      spacing,
      children: [new TextRun({ text: normalizePlainCitationLine(line), ...trOpts })],
    });
  });
}

async function buildProjectDocxBuffer({ projectName, sections, citationStyle }) {
  const cs = citationStyle != null ? String(citationStyle) : 'APA';
  const trOpts = textRunOptionsForCitationStyle(cs);
  const title = String(projectName || 'Project').trim() || 'Project';
  const flat = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: title, ...trOpts })],
    }),
  ];
  for (let i = 0; i < (sections || []).length; i++) {
    const sec = sections[i];
    flat.push(new Paragraph({ text: '' }));
    flat.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: [new TextRun({ text: String(sec.title || 'Section'), ...trOpts })],
      })
    );
    paragraphChildrenFromSectionBody(sec.body, cs).forEach((p) => flat.push(p));
  }
  const doc = new Document({
    sections: [{ children: flat }],
  });
  return Packer.toBuffer(doc);
}

function contentDispositionAttachment(filename) {
  const f = String(filename);
  const ascii = f.replace(/[^\x20-\x7E]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f)}`;
}

module.exports = {
  htmlToPlainLines,
  sanitizeFilename,
  buildPlainTextForProject,
  buildSectionDocxBuffer,
  buildProjectDocxBuffer,
  contentDispositionAttachment,
};
