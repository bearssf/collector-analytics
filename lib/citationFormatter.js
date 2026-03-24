'use strict';

/* ------------------------------------------------------------------ */
/*  citationFormatter.js — format a source object as an HTML citation */
/*  Supports: APA 7, MLA 9, Chicago 17 N-B, Harvard, IEEE,          */
/*            AMA 11, Vancouver (ICMJE/NLM), Turabian 9              */
/* ------------------------------------------------------------------ */

/* ========================  helpers  =============================== */

function parseAuthors(str) {
  if (!str) return [];
  return str
    .split(';')
    .map((a) => {
      const parts = a.trim().split(',').map((p) => p.trim());
      return { last: parts[0] || '', first: parts.slice(1).join(',').trim() };
    })
    .filter((a) => a.last);
}

function initials(firstName, periods) {
  if (!firstName) return '';
  return firstName
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((n) => n[0].toUpperCase() + (periods ? '.' : ''))
    .join(periods ? ' ' : '');
}

function has(v) {
  return v !== undefined && v !== null && String(v).trim() !== '';
}

function em(text) {
  return `<em>${text}</em>`;
}

function doi2url(doi) {
  if (!doi) return '';
  doi = doi.trim();
  if (doi.startsWith('http')) return doi;
  return `https://doi.org/${doi.replace(/^doi:\s*/i, '')}`;
}

function inferType(src) {
  if (has(src.source_type)) return src.source_type.toLowerCase();
  if (has(src.conference_name)) return 'conference';
  if (has(src.chapter_name)) return 'chapter';
  if (has(src.journal_title)) return 'journal';
  return 'book';
}

/* ========================  APA 7th  =============================== */

function apaAuthors(authors) {
  const fmt = (a) => `${a.last}, ${initials(a.first, true)}`;
  if (authors.length === 0) return '';
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length === 2)
    return `${fmt(authors[0])}, &amp; ${fmt(authors[1])}`;
  if (authors.length <= 20)
    return (
      authors
        .slice(0, -1)
        .map(fmt)
        .join(', ') +
      ', &amp; ' +
      fmt(authors[authors.length - 1])
    );
  return (
    authors
      .slice(0, 19)
      .map(fmt)
      .join(', ') +
    ', . . . ' +
    fmt(authors[authors.length - 1])
  );
}

function formatAPA(src, authors) {
  const type = inferType(src);
  const date = has(src.publication_date) ? `(${src.publication_date})` : '(n.d.)';
  const authorStr = apaAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}. ${date}. ${src.article_title}. `;
    ref += em(src.journal_title);
    if (has(src.volume_number)) ref += `, ${em(src.volume_number)}`;
    if (has(src.issue_number)) ref += `(${src.issue_number})`;
    if (has(src.page_numbers)) ref += `, ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}`;
    else if (has(src.url)) ref += ` ${src.url}`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}. ${date}. ${src.chapter_name}. `;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      const edStr = eds.map((e) => `${initials(e.first, true)} ${e.last}`).join(', ');
      ref += `In ${edStr} (Ed${eds.length > 1 ? 's' : ''}.), `;
    } else {
      ref += 'In ';
    }
    ref += em(bookTitle);
    if (has(src.edition)) ref += ` (${src.edition})`;
    if (has(src.page_numbers)) ref += ` (pp. ${src.page_numbers})`;
    ref += '.';
    if (has(src.publisher)) ref += ` ${src.publisher}.`;
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}`;
    else if (has(src.url)) ref += ` ${src.url}`;
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}. ${date}. ${src.article_title}. `;
    if (has(src.conference_name)) ref += `In ${em(src.conference_name)}`;
    if (has(src.page_numbers)) ref += ` (pp. ${src.page_numbers})`;
    ref += '.';
    if (has(src.publisher)) ref += ` ${src.publisher}.`;
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}`;
    else if (has(src.url)) ref += ` ${src.url}`;
    return ref;
  }

  // book
  let ref = `${authorStr}. ${date}. ${em(src.article_title || src.journal_title)}`;
  if (has(src.edition)) ref += ` (${src.edition})`;
  ref += '.';
  if (has(src.publisher)) ref += ` ${src.publisher}.`;
  if (has(src.doi)) ref += ` ${doi2url(src.doi)}`;
  else if (has(src.url)) ref += ` ${src.url}`;
  return ref;
}

/* ========================  MLA 9th  =============================== */

function mlaAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length === 1)
    return `${authors[0].last}, ${authors[0].first}`;
  if (authors.length === 2)
    return `${authors[0].last}, ${authors[0].first}, and ${authors[1].first} ${authors[1].last}`;
  return `${authors[0].last}, ${authors[0].first}, et al.`;
}

function formatMLA(src, authors) {
  const type = inferType(src);
  const authorStr = mlaAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}. &ldquo;${src.article_title}.&rdquo; `;
    ref += em(src.journal_title);
    if (has(src.volume_number)) ref += `, vol. ${src.volume_number}`;
    if (has(src.issue_number)) ref += `, no. ${src.issue_number}`;
    if (has(src.publication_date)) ref += `, ${src.publication_date}`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}. &ldquo;${src.chapter_name}.&rdquo; `;
    ref += em(bookTitle) + ', ';
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      const edStr = eds.map((e) => `${e.first} ${e.last}`).join(' and ');
      ref += `edited by ${edStr}, `;
    }
    if (has(src.publisher)) ref += `${src.publisher}, `;
    if (has(src.publication_date)) ref += `${src.publication_date}, `;
    if (has(src.page_numbers)) ref += `pp. ${src.page_numbers}`;
    ref = ref.replace(/,\s*$/, '') + '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}. &ldquo;${src.article_title}.&rdquo; `;
    if (has(src.conference_name)) ref += em(src.conference_name) + ', ';
    if (has(src.publication_date)) ref += `${src.publication_date}, `;
    if (has(src.page_numbers)) ref += `pp. ${src.page_numbers}`;
    ref = ref.replace(/,\s*$/, '') + '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  // book
  let ref = `${authorStr}. ${em(src.article_title || src.journal_title)}. `;
  if (has(src.edition)) ref += `${src.edition}, `;
  if (has(src.publisher)) ref += `${src.publisher}, `;
  if (has(src.publication_date)) ref += `${src.publication_date}`;
  ref = ref.replace(/,\s*$/, '') + '.';
  if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
  else if (has(src.url)) ref += ` ${src.url}.`;
  return ref;
}

/* ====================  Chicago 17th (N-B)  ======================== */

function chicagoAuthors(authors) {
  if (authors.length === 0) return '';
  const first = `${authors[0].last}, ${authors[0].first}`;
  if (authors.length === 1) return first;
  if (authors.length === 2)
    return `${first}, and ${authors[1].first} ${authors[1].last}`;
  if (authors.length <= 10)
    return (
      first +
      ', ' +
      authors
        .slice(1, -1)
        .map((a) => `${a.first} ${a.last}`)
        .join(', ') +
      ', and ' +
      `${authors[authors.length - 1].first} ${authors[authors.length - 1].last}`
    );
  return (
    first +
    ', ' +
    authors
      .slice(1, 7)
      .map((a) => `${a.first} ${a.last}`)
      .join(', ') +
    ', et al.'
  );
}

function formatChicago(src, authors) {
  const type = inferType(src);
  const authorStr = chicagoAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}. &ldquo;${src.article_title}.&rdquo; `;
    ref += em(src.journal_title);
    if (has(src.volume_number)) ref += ` ${src.volume_number}`;
    if (has(src.issue_number)) ref += `, no. ${src.issue_number}`;
    if (has(src.publication_date)) ref += ` (${src.publication_date})`;
    if (has(src.page_numbers)) ref += `: ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}. &ldquo;${src.chapter_name}.&rdquo; In ${em(bookTitle)}`;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      const edStr = eds.map((e) => `${e.first} ${e.last}`).join(' and ');
      ref += `, edited by ${edStr}`;
    }
    if (has(src.page_numbers)) ref += `, ${src.page_numbers}`;
    ref += '.';
    if (has(src.publisher_location) && has(src.publisher))
      ref += ` ${src.publisher_location}: ${src.publisher},`;
    else if (has(src.publisher)) ref += ` ${src.publisher},`;
    if (has(src.publication_date)) ref += ` ${src.publication_date}`;
    ref = ref.replace(/,\s*$/, '') + '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}. &ldquo;${src.article_title}.&rdquo; `;
    if (has(src.conference_name))
      ref += `Paper presented at ${src.conference_name}`;
    if (has(src.publisher_location)) ref += `, ${src.publisher_location}`;
    if (has(src.publication_date)) ref += `, ${src.publication_date}`;
    ref += '.';
    if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
    else if (has(src.url)) ref += ` ${src.url}.`;
    return ref;
  }

  // book
  let ref = `${authorStr}. ${em(src.article_title || src.journal_title)}.`;
  if (has(src.edition)) ref += ` ${src.edition}.`;
  if (has(src.publisher_location) && has(src.publisher))
    ref += ` ${src.publisher_location}: ${src.publisher},`;
  else if (has(src.publisher)) ref += ` ${src.publisher},`;
  if (has(src.publication_date)) ref += ` ${src.publication_date}`;
  ref = ref.replace(/,\s*$/, '') + '.';
  if (has(src.doi)) ref += ` ${doi2url(src.doi)}.`;
  else if (has(src.url)) ref += ` ${src.url}.`;
  return ref;
}

/* =======================  Harvard  ================================ */

function harvardAuthors(authors) {
  const fmt = (a) => `${a.last}, ${initials(a.first, true)}`;
  if (authors.length === 0) return '';
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length === 2)
    return `${fmt(authors[0])} and ${fmt(authors[1])}`;
  if (authors.length <= 3)
    return (
      authors
        .slice(0, -1)
        .map(fmt)
        .join(', ') +
      ' and ' +
      fmt(authors[authors.length - 1])
    );
  return `${fmt(authors[0])} et al.`;
}

function formatHarvard(src, authors) {
  const type = inferType(src);
  const authorStr = harvardAuthors(authors);
  const year = has(src.publication_date) ? src.publication_date : 'n.d.';

  if (type === 'journal') {
    let ref = `${authorStr} (${year}) &lsquo;${src.article_title}&rsquo;, `;
    ref += em(src.journal_title);
    if (has(src.volume_number)) ref += `, ${src.volume_number}`;
    if (has(src.issue_number)) ref += `(${src.issue_number})`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi:${src.doi.replace(/^doi:\s*/i, '')}.`;
    else if (has(src.url)) {
      ref += ` Available at: ${src.url}`;
      if (has(src.access_date)) ref += ` (Accessed: ${src.access_date})`;
      ref += '.';
    }
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr} (${year}) &lsquo;${src.chapter_name}&rsquo;, in `;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      const edStr = eds.map((e) => `${initials(e.first, true)} ${e.last}`).join(', ');
      ref += `${edStr} (ed${eds.length > 1 ? 's' : ''}.) `;
    }
    ref += em(bookTitle);
    if (has(src.edition)) ref += `, ${src.edition}`;
    ref += '.';
    if (has(src.publisher_location) && has(src.publisher))
      ref += ` ${src.publisher_location}: ${src.publisher}`;
    else if (has(src.publisher)) ref += ` ${src.publisher}`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr} (${year}) &lsquo;${src.article_title}&rsquo;, `;
    if (has(src.conference_name)) ref += em(src.conference_name);
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi:${src.doi.replace(/^doi:\s*/i, '')}.`;
    else if (has(src.url)) ref += ` Available at: ${src.url}.`;
    return ref;
  }

  // book
  let ref = `${authorStr} (${year}) ${em(src.article_title || src.journal_title)}`;
  if (has(src.edition)) ref += `, ${src.edition}`;
  ref += '.';
  if (has(src.publisher_location) && has(src.publisher))
    ref += ` ${src.publisher_location}: ${src.publisher}.`;
  else if (has(src.publisher)) ref += ` ${src.publisher}.`;
  return ref;
}

/* =========================  IEEE  ================================= */

function ieeeAuthors(authors) {
  const fmt = (a) => `${initials(a.first, true)} ${a.last}`;
  if (authors.length === 0) return '';
  if (authors.length === 1) return fmt(authors[0]);
  if (authors.length === 2)
    return `${fmt(authors[0])} and ${fmt(authors[1])}`;
  if (authors.length <= 6)
    return (
      authors
        .slice(0, -1)
        .map(fmt)
        .join(', ') +
      ', and ' +
      fmt(authors[authors.length - 1])
    );
  return `${fmt(authors[0])} et al.`;
}

function formatIEEE(src, authors) {
  const type = inferType(src);
  const authorStr = ieeeAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}, &ldquo;${src.article_title},&rdquo; `;
    ref += em(src.journal_title);
    if (has(src.volume_number)) ref += `, vol. ${src.volume_number}`;
    if (has(src.issue_number)) ref += `, no. ${src.issue_number}`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    if (has(src.publication_date)) ref += `, ${src.publication_date}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi: ${src.doi.replace(/^doi:\s*/i, '')}.`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}, &ldquo;${src.chapter_name},&rdquo; in ${em(bookTitle)}`;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      const edStr = eds.map((e) => `${initials(e.first, true)} ${e.last}`).join(', ');
      ref += `, ${edStr}, Ed${eds.length > 1 ? 's' : ''}.`;
    }
    if (has(src.publisher_location) && has(src.publisher))
      ref += ` ${src.publisher_location}: ${src.publisher}`;
    else if (has(src.publisher)) ref += ` ${src.publisher}`;
    if (has(src.publication_date)) ref += `, ${src.publication_date}`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}, &ldquo;${src.article_title},&rdquo; `;
    if (has(src.conference_name)) ref += `in ${em(src.conference_name)}`;
    if (has(src.publication_date)) ref += `, ${src.publication_date}`;
    if (has(src.page_numbers)) ref += `, pp. ${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi: ${src.doi.replace(/^doi:\s*/i, '')}.`;
    return ref;
  }

  // book
  let ref = `${authorStr}, ${em(src.article_title || src.journal_title)}`;
  if (has(src.edition)) ref += `, ${src.edition}`;
  ref += '.';
  if (has(src.publisher_location) && has(src.publisher))
    ref += ` ${src.publisher_location}: ${src.publisher}`;
  else if (has(src.publisher)) ref += ` ${src.publisher}`;
  if (has(src.publication_date)) ref += `, ${src.publication_date}`;
  ref += '.';
  return ref;
}

/* =========================  AMA 11th  ============================= */

function amaAuthor(a) {
  return `${a.last} ${initials(a.first, false)}`;
}

function amaAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length <= 6) return authors.map(amaAuthor).join(', ');
  return (
    authors
      .slice(0, 3)
      .map(amaAuthor)
      .join(', ') + ', et al'
  );
}

function formatAMA(src, authors) {
  const type = inferType(src);
  const authorStr = amaAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}. ${src.article_title}. `;
    ref += em(src.journal_title) + '.';
    if (has(src.publication_date)) ref += ` ${src.publication_date}`;
    if (has(src.volume_number)) ref += `;${src.volume_number}`;
    if (has(src.issue_number)) ref += `(${src.issue_number})`;
    if (has(src.page_numbers)) ref += `:${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi:${src.doi.replace(/^doi:\s*/i, '')}`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}. ${src.chapter_name}. In: `;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      ref += eds.map(amaAuthor).join(', ');
      ref += `, ed${eds.length > 1 ? 's' : ''}. `;
    }
    ref += em(bookTitle) + '.';
    if (has(src.edition)) ref += ` ${src.edition}.`;
    if (has(src.publisher_location) && has(src.publisher))
      ref += ` ${src.publisher_location}: ${src.publisher};`;
    else if (has(src.publisher)) ref += ` ${src.publisher};`;
    if (has(src.publication_date)) ref += ` ${src.publication_date}`;
    if (has(src.page_numbers)) ref += `:${src.page_numbers}`;
    ref += '.';
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}. ${src.article_title}. `;
    if (has(src.conference_name))
      ref += `Presented at: ${src.conference_name}`;
    if (has(src.publication_date)) ref += `; ${src.publication_date}`;
    if (has(src.publisher_location)) ref += `; ${src.publisher_location}`;
    ref += '.';
    return ref;
  }

  // book
  let ref = `${authorStr}. ${em(src.article_title || src.journal_title)}.`;
  if (has(src.edition)) ref += ` ${src.edition}.`;
  if (has(src.publisher_location) && has(src.publisher))
    ref += ` ${src.publisher_location}: ${src.publisher};`;
  else if (has(src.publisher)) ref += ` ${src.publisher};`;
  if (has(src.publication_date)) ref += ` ${src.publication_date}`;
  ref += '.';
  return ref;
}

/* ====================  Vancouver (ICMJE/NLM)  ===================== */

function vanAuthor(a) {
  return `${a.last} ${initials(a.first, false)}`;
}

function vanAuthors(authors) {
  if (authors.length === 0) return '';
  if (authors.length <= 6) return authors.map(vanAuthor).join(', ');
  return (
    authors
      .slice(0, 6)
      .map(vanAuthor)
      .join(', ') + ', et al'
  );
}

function formatVancouver(src, authors) {
  const type = inferType(src);
  const authorStr = vanAuthors(authors);

  if (type === 'journal') {
    let ref = `${authorStr}. ${src.article_title}. `;
    ref += src.journal_title + '.';
    if (has(src.publication_date)) ref += ` ${src.publication_date}`;
    if (has(src.volume_number)) ref += `;${src.volume_number}`;
    if (has(src.issue_number)) ref += `(${src.issue_number})`;
    if (has(src.page_numbers)) ref += `:${src.page_numbers}`;
    ref += '.';
    if (has(src.doi)) ref += ` doi:${src.doi.replace(/^doi:\s*/i, '')}`;
    return ref;
  }

  if (type === 'chapter') {
    const bookTitle = has(src.book_title) ? src.book_title : src.journal_title;
    let ref = `${authorStr}. ${src.chapter_name}. In: `;
    if (has(src.editors)) {
      const eds = parseAuthors(src.editors);
      ref += eds.map(vanAuthor).join(', ');
      ref += `, editor${eds.length > 1 ? 's' : ''}. `;
    }
    ref += bookTitle + '.';
    if (has(src.edition)) ref += ` ${src.edition}.`;
    if (has(src.publisher_location) && has(src.publisher))
      ref += ` ${src.publisher_location}: ${src.publisher};`;
    else if (has(src.publisher)) ref += ` ${src.publisher};`;
    if (has(src.publication_date)) ref += ` ${src.publication_date}`;
    if (has(src.page_numbers)) ref += `. p. ${src.page_numbers}`;
    ref += '.';
    return ref;
  }

  if (type === 'conference') {
    let ref = `${authorStr}. ${src.article_title}. `;
    if (has(src.conference_name))
      ref += `In: ${src.conference_name}`;
    if (has(src.publication_date)) ref += `; ${src.publication_date}`;
    if (has(src.publisher_location)) ref += `; ${src.publisher_location}`;
    ref += '.';
    if (has(src.page_numbers)) ref += ` p. ${src.page_numbers}.`;
    return ref;
  }

  // book
  let ref = `${authorStr}. ${src.article_title || src.journal_title}.`;
  if (has(src.edition)) ref += ` ${src.edition}.`;
  if (has(src.publisher_location) && has(src.publisher))
    ref += ` ${src.publisher_location}: ${src.publisher};`;
  else if (has(src.publisher)) ref += ` ${src.publisher};`;
  if (has(src.publication_date)) ref += ` ${src.publication_date}`;
  ref += '.';
  return ref;
}

/* =======================  Turabian 9th  =========================== */

function formatTurabian(src, authors) {
  return formatChicago(src, authors);
}

/* =========================  router  =============================== */

/**
 * Format a research source as an HTML citation string.
 *
 * @param {object} source  — source fields (see README / field list)
 * @param {string} style   — one of APA, MLA, Chicago, Harvard, IEEE,
 *                            AMA, Vancouver, Turabian (case-insensitive)
 * @returns {string} HTML string with <em> for italics and HTML entities
 *                   for smart quotes
 */
function formatCitation(source, style) {
  if (!source) throw new Error('source is required');
  if (!style) throw new Error('style is required');

  const authors = parseAuthors(source.authors);
  const key = style.trim().toUpperCase();

  switch (key) {
    case 'APA':
      return formatAPA(source, authors);
    case 'MLA':
      return formatMLA(source, authors);
    case 'CHICAGO':
      return formatChicago(source, authors);
    case 'HARVARD':
      return formatHarvard(source, authors);
    case 'IEEE':
      return formatIEEE(source, authors);
    case 'AMA':
      return formatAMA(source, authors);
    case 'VANCOUVER':
      return formatVancouver(source, authors);
    case 'TURABIAN':
      return formatTurabian(source, authors);
    default:
      throw new Error(`Unsupported citation style: ${style}`);
  }
}

module.exports = { formatCitation, parseAuthors };
