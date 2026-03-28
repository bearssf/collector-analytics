const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  LineRuleType,
  AlignmentType,
  convertInchesToTwip,
} = require('docx');

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

function stripColorFromHtml(html) {
  let s = String(html || '');
  s = s.replace(/\s*color\s*:\s*[^;}"']+;?/gi, '');
  s = s.replace(/\s*background-color\s*:\s*[^;}"']+;?/gi, '');
  s = s.replace(/\sclass="([^"]*)"/g, function (_m, c) {
    const cleaned = c
      .split(/\s+/)
      .filter(function (cl) {
        return (
          cl &&
          !/^ql-color-/.test(cl) &&
          !/^ql-bg-color-/.test(cl) &&
          !/^ql-color$/.test(cl)
        );
      })
      .join(' ');
    return cleaned ? ' class="' + cleaned + '"' : '';
  });
  return s;
}

function decodeBasicEntities(s) {
  return String(s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractTextFromHtmlFragment(inner) {
  let t = String(inner || '');
  t = t.replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/<[^>]+>/g, '');
  return decodeBasicEntities(t);
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

function htmlFromStoredSectionBody(stored) {
  if (stored == null || !String(stored).trim()) return '';
  const s = String(stored).trim();
  if (isAnvilMsHtmlJson(s)) {
    try {
      const o = JSON.parse(s);
      return String(o.html || '');
    } catch (e) {
      return '';
    }
  }
  if (isQuillDeltaJson(s)) return '';
  return s;
}

/**
 * Strip Quill/HTML to plain lines for .txt / fallback.
 */
function htmlToPlainLines(html) {
  if (html == null || !String(html).trim()) return [];
  let s = stripColorFromHtml(String(html));
  s = s.replace(/<\/p>/gi, '\n');
  s = s.replace(/<\/li>/gi, '\n');
  s = s.replace(/<\/h[1-6][^>]*>/gi, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeBasicEntities(s);
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
    return { font: 'Times New Roman', size: 20, color: '000000' };
  }
  return { font: 'Times New Roman', size: 24, color: '000000' };
}

function bodyIndentForCitationStyle(citationStyle) {
  const s = String(citationStyle || 'APA').toUpperCase();
  if (s === 'IEEE') return undefined;
  return { firstLine: convertInchesToTwip(0.5) };
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

function parseBlockElements(html) {
  const raw = stripColorFromHtml(String(html || ''));
  const blocks = [];
  const re = /<(p|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2] || '';
    const inner = m[3];
    const text = extractTextFromHtmlFragment(inner).replace(/\s+/g, ' ').trim();
    const alignCenter =
      /\bql-align-center\b/.test(attrs) || /text-align\s*:\s*center/i.test(attrs);
    const isH = /^h[1-6]$/.test(tag);
    const level = isH ? parseInt(tag.charAt(1), 10) : 0;
    blocks.push({
      text,
      alignCenter,
      isHeading: isH,
      headingLevel: level,
    });
  }
  if (!blocks.length) {
    htmlToPlainLines(raw).forEach(function (line) {
      blocks.push({
        text: line,
        alignCenter: false,
        isHeading: false,
        headingLevel: 0,
      });
    });
  }
  return blocks;
}

function leadingEmptyParagraphs(count, spacing, trOpts) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(
      new Paragraph({
        spacing,
        children: [new TextRun({ text: '', ...trOpts })],
      })
    );
  }
  return out;
}

function buildParagraphsFromHtmlBlocks(html, citationStyle, options) {
  const opts = options || {};
  const cs = String(citationStyle || 'APA').toUpperCase();
  const spacing = lineSpacingForCitationStyle(cs);
  const trOpts = textRunOptionsForCitationStyle(cs);
  const blocks = parseBlockElements(html);
  const out = [];

  if (opts.leadingEmptyLines > 0) {
    leadingEmptyParagraphs(opts.leadingEmptyLines, spacing, trOpts).forEach(function (p) {
      out.push(p);
    });
  }

  blocks.forEach(function (b) {
    if (b.isHeading && !opts.isTitlePage) {
      out.push(
        new Paragraph({
          spacing,
          alignment: AlignmentType.LEFT,
          indent: { firstLine: 0 },
          children: [new TextRun({ text: b.text, bold: true, ...trOpts })],
        })
      );
      return;
    }
    const align = b.alignCenter ? AlignmentType.CENTER : AlignmentType.LEFT;
    let indent;
    if (opts.bodyIndent && !opts.isTitlePage && !b.alignCenter && !b.isHeading) {
      indent = bodyIndentForCitationStyle(cs);
    }
    out.push(
      new Paragraph({
        spacing,
        alignment: align,
        indent,
        children: [new TextRun({ text: b.text || ' ', ...trOpts })],
      })
    );
  });

  return out;
}

function buildTitleSectionDocxParagraphs(html, citationStyle) {
  const cs = String(citationStyle || 'APA').toUpperCase();
  const spacing = lineSpacingForCitationStyle(cs);
  const trOpts = textRunOptionsForCitationStyle(cs);
  const out = leadingEmptyParagraphs(4, spacing, trOpts);
  const raw = stripColorFromHtml(String(html || ''));
  const re = /<(p|h[1-6])(\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(raw)) !== null) {
    const inner = m[3];
    const text = extractTextFromHtmlFragment(inner).replace(/\s+/g, ' ').trim();
    const bold = /<strong\b/i.test(inner) || /<b\b/i.test(inner);
    out.push(
      new Paragraph({
        spacing,
        alignment: AlignmentType.CENTER,
        indent: { firstLine: 0 },
        children: [new TextRun({ text: text || ' ', bold: !!bold, ...trOpts })],
      })
    );
  }
  if (out.length === 4) {
    htmlToPlainLines(raw).forEach(function (line) {
      out.push(
        new Paragraph({
          spacing,
          alignment: AlignmentType.CENTER,
          indent: { firstLine: 0 },
          children: [new TextRun({ text: line, ...trOpts })],
        })
      );
    });
  }
  return out;
}

function paragraphChildrenFromHtmlStructured(html, citationStyle) {
  return buildParagraphsFromHtmlBlocks(html, citationStyle, {
    isTitlePage: false,
    bodyIndent: true,
    leadingEmptyLines: 0,
  });
}

async function buildSectionDocxBuffer({ title, html, citationStyle, sectionSlug }) {
  const cs = citationStyle != null ? String(citationStyle) : 'APA';
  const trOpts = textRunOptionsForCitationStyle(cs);
  const slug = String(sectionSlug || '').toLowerCase();
  const cleanHtml = stripColorFromHtml(html);

  if (slug === 'title') {
    const children = buildTitleSectionDocxParagraphs(cleanHtml, cs);
    const doc = new Document({
      sections: [{ children }],
    });
    return Packer.toBuffer(doc);
  }

  const heading = String(title || 'Section').trim() || 'Section';
  const bodyChildren = paragraphChildrenFromHtmlStructured(cleanHtml, cs);
  const children = [
    new Paragraph({
      spacing: lineSpacingForCitationStyle(cs),
      children: [new TextRun({ ...trOpts, text: heading, bold: true, size: 32 })],
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
  const html = htmlFromStoredSectionBody(storedBody);
  if (html && String(html).trim()) {
    return paragraphChildrenFromHtmlStructured(html, cs);
  }
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
      indent: bodyIndentForCitationStyle(cs),
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
      spacing: lineSpacingForCitationStyle(cs),
      children: [new TextRun({ ...trOpts, text: title, bold: true, size: 32 })],
    }),
  ];
  for (let i = 0; i < (sections || []).length; i++) {
    const sec = sections[i];
    const slug = String(sec.slug != null ? sec.slug : sec.section_slug || '')
      .trim()
      .toLowerCase();
    if (slug === 'title') {
      const inner = buildTitleSectionDocxParagraphs(stripColorFromHtml(htmlFromStoredSectionBody(sec.body) || String(sec.body || '')), cs);
      inner.forEach(function (p) {
        flat.push(p);
      });
      continue;
    }
    flat.push(new Paragraph({ text: '' }));
    flat.push(
      new Paragraph({
        spacing: lineSpacingForCitationStyle(cs),
        children: [
          new TextRun({ ...trOpts, text: String(sec.title || 'Section'), bold: true, size: 28 }),
        ],
      })
    );
    paragraphChildrenFromSectionBody(sec.body, cs).forEach(function (p) {
      flat.push(p);
    });
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
  stripColorFromHtml,
  sanitizeFilename,
  buildPlainTextForProject,
  buildSectionDocxBuffer,
  buildProjectDocxBuffer,
  contentDispositionAttachment,
};
