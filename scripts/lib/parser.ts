/**
 * Multi-format parser for Israeli legislation.
 *
 * Handles two content formats:
 *   1. HTML  -- from UCI mirror (Privacy Protection Law)
 *   2. Plain text -- from pdftotext extraction (Computer Law, Basic Law)
 *
 * Israeli laws use "Section N" numbering, not "Article N".
 * Basic Laws use numbered sections without the "Section" prefix in some formats.
 */

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface ActIndexEntry {
  id: string;
  lawName: string;
  year: number;
  title: string;
  titleEn: string;
  abbreviation: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issuedDate: string;
  inForceDate: string;
  url: string;
}

export interface ParsedProvision {
  provision_ref: string;
  chapter?: string;
  section: string;
  title: string;
  content: string;
}

export interface ParsedDefinition {
  term: string;
  definition: string;
  source_provision?: string;
}

export interface ParsedAct {
  id: string;
  type: 'statute';
  title: string;
  title_en: string;
  short_name: string;
  status: 'in_force' | 'amended' | 'repealed' | 'not_yet_in_force';
  issued_date: string;
  in_force_date: string;
  url: string;
  description?: string;
  provisions: ParsedProvision[];
  definitions: ParsedDefinition[];
}

// ---------------------------------------------------------------------------
// HTML utilities
// ---------------------------------------------------------------------------

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// HTML Parser -- for UCI mirror format (Privacy Protection Law)
//
// Structure: <B>N. Title</B> ... <P><B>N+1. Title</B>
// Chapters: <B>CHAPTER ...: ...</B>
// ---------------------------------------------------------------------------

export function parsePrivacyLawHtml(html: string, act: ActIndexEntry): ParsedAct {
  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  // Extract the law body (inside the main table)
  const bodyMatch = html.match(/PROTECTION OF PRIVACY LAW[\s\S]*?(?=<\/TD>\s*<\/TR>\s*<\/TABLE>\s*<BR>)/i);
  const body = bodyMatch ? bodyMatch[0] : html;

  let currentChapter = '';

  // Split by bold section numbers: <B>N. or <B><a name=...>N.
  // Pattern: <B> optionally <a name="..."></a> then section number. title</B>
  const sectionPattern = /<B>(?:<a[^>]*><\/a>)?\s*(\d+[A-Z]?)\.\s+([^<]+)<\/B>/gi;
  const chapterPattern = /<B>\s*(CHAPTER\s+[^:]+:\s*[^<]+)<\/B>/gi;

  // First, collect chapter positions
  const chapters: Array<{ pos: number; name: string }> = [];
  let chMatch;
  while ((chMatch = chapterPattern.exec(body)) !== null) {
    chapters.push({ pos: chMatch.index, name: normalizeText(stripHtml(chMatch[1])) });
  }

  // Also collect article positions (Article One: Data Bases, Article Two: Direct Mail)
  const articlePattern = /<B>\s*(Article\s+[^:]+:\s*[^<]+)<\/B>/gi;
  while ((chMatch = articlePattern.exec(body)) !== null) {
    chapters.push({ pos: chMatch.index, name: normalizeText(stripHtml(chMatch[1])) });
  }
  chapters.sort((a, b) => a.pos - b.pos);

  // Collect all section matches
  const sectionMatches: Array<{ pos: number; num: string; title: string }> = [];
  let secMatch;
  while ((secMatch = sectionPattern.exec(body)) !== null) {
    sectionMatches.push({
      pos: secMatch.index,
      num: secMatch[1].trim(),
      title: normalizeText(stripHtml(secMatch[2])),
    });
  }

  // For each section, determine its chapter and extract content
  for (let i = 0; i < sectionMatches.length; i++) {
    const sec = sectionMatches[i];
    const nextSec = sectionMatches[i + 1];

    // Determine chapter for this section
    for (const ch of chapters) {
      if (ch.pos < sec.pos) {
        currentChapter = ch.name;
      }
    }

    // Extract content between this section and next section
    const startPos = sec.pos;
    const endPos = nextSec ? nextSec.pos : body.length;
    const rawContent = body.substring(startPos, endPos);
    const content = normalizeText(stripHtml(rawContent));

    if (content.length > 10) {
      const provRef = `sec${sec.num}`;

      provisions.push({
        provision_ref: provRef,
        chapter: currentChapter || undefined,
        section: sec.num,
        title: sec.title,
        content: content.substring(0, 8000),
      });

      // Extract definitions from Section 3 and Section 7 (definition sections)
      if (sec.num === '3' || sec.num === '7' || sec.num === '17C') {
        extractDefinitionsFromContent(content, provRef, definitions);
      }
    }
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.abbreviation,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    provisions,
    definitions,
  };
}

// ---------------------------------------------------------------------------
// Plain-text Parser -- for pdftotext output (Computer Law, Basic Law)
//
// Computer Law format:
//   "Section N\n\nTitle text\n\nN. content..."
//   or just "N. content..."
//
// Basic Law format:
//   "Title label\n\nN. content..."
// ---------------------------------------------------------------------------

export function parseComputerLawText(text: string, act: ActIndexEntry): ParsedAct {
  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  // The Computer Law PDF from UNODC has a two-part structure:
  //   1. Table of Contents (contains "Section N" + "Go" lines)
  //   2. Actual law text starting with "Computers Law, 5755"
  // We skip the ToC and parse only the actual law text.

  const lawTextStart = text.indexOf('Computers Law, 5755');
  const lawText = lawTextStart >= 0 ? text.substring(lawTextStart) : text;

  let currentChapter = '';
  const lines = lawText.split('\n');
  const sections: Array<{ num: string; title: string; content: string; chapter: string }> = [];
  let currentSection: { num: string; title: string; content: string; chapter: string } | null = null;

  // Track marginal note lines (title labels that appear before section numbers)
  let marginalNoteLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect chapter headings
    const chapterMatch = line.match(/^Chapter\s+(One|Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten|\w+):\s*(.+)/i);
    if (chapterMatch) {
      currentChapter = normalizeText(line);
      marginalNoteLines = [];
      continue;
    }

    // Pattern 1: "N." alone on a line (section number with content on next line)
    // This is the common PDF format where the number is isolated
    const sectionAloneMatch = line.match(/^(\d+[A-Za-z]?)\.\s*$/);
    if (sectionAloneMatch) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }

      // The marginal note lines before this number are the title
      const titleCandidates = marginalNoteLines.filter((l) =>
        l.length > 0 && l.length < 100
        && !l.match(/^Chapter\s+/i) && !l.match(/^Go$/i)
        && !l.match(/^Section\s+\d+/) && !l.match(/^Clause\s+/i)
        && !l.match(/^\*/) && !l.match(/^Contents$/)
        && !l.match(/^\d+$/) && !l.match(/^Computers Law/i)
        && !l.match(/^Published in/i)
      );
      const title = normalizeText(titleCandidates.join(' '));

      currentSection = {
        num: sectionAloneMatch[1],
        title: title,
        content: '',
        chapter: currentChapter,
      };
      marginalNoteLines = [];
      continue;
    }

    // Pattern 2: "N. (a) content" or "N. Content text" on the same line
    const sectionInlineMatch = line.match(/^(\d+[A-Za-z]?)\.\s+(.+)/);
    if (sectionInlineMatch) {
      // Check this isn't a page footnote like "* Published in..."
      if (sectionInlineMatch[2].match(/^Published in/i)) {
        continue;
      }

      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }

      // Marginal note = title
      const titleCandidates = marginalNoteLines.filter((l) =>
        l.length > 0 && l.length < 100
        && !l.match(/^Chapter\s+/i) && !l.match(/^Go$/i)
        && !l.match(/^Section\s+\d+/) && !l.match(/^Clause\s+/i)
        && !l.match(/^\*/) && !l.match(/^Contents$/)
        && !l.match(/^\d+$/) && !l.match(/^Computers Law/i)
      );
      const title = normalizeText(titleCandidates.join(' '));

      currentSection = {
        num: sectionInlineMatch[1],
        title: title,
        content: normalizeText(sectionInlineMatch[0]),
        chapter: currentChapter,
      };
      marginalNoteLines = [];
      continue;
    }

    // Accumulate content for current section
    if (currentSection && line.length > 0) {
      // Skip page numbers (standalone digits), headers, and footnote markers
      if (line.match(/^\d+$/) && line.length <= 3) continue;
      if (line.match(/^Computers Law, 1995/i)) continue;

      currentSection.content += ' ' + normalizeText(line);
    } else if (!currentSection && line.length > 0) {
      // Track marginal note lines (before any section starts, or between sections)
      if (!line.match(/^Go$/i) && !line.match(/^Section\s+\d+/)
          && !line.match(/^Computers Law/i) && !line.match(/^\d+$/)
          && !line.match(/^\*$/) && !line.match(/^Published in/i)) {
        marginalNoteLines.push(line);
      } else {
        // Reset on non-title lines
        if (line.match(/^Go$/i) || line.match(/^Section\s+\d+/)) {
          marginalNoteLines = [];
        }
      }
    } else if (line.length === 0 && !currentSection) {
      // Empty line resets marginal notes only if we haven't started collecting them recently
      // Keep them -- marginal notes can span across blank lines in PDF
    }
  }

  // Save last section
  if (currentSection) {
    sections.push(currentSection);
  }

  for (const sec of sections) {
    const content = normalizeText(sec.content);
    if (content.length > 10) {
      provisions.push({
        provision_ref: `sec${sec.num}`,
        chapter: sec.chapter || undefined,
        section: sec.num,
        title: sec.title,
        content: content.substring(0, 8000),
      });

      // Extract definitions from Section 1 (uses regular quotes in PDF text)
      if (sec.num === '1') {
        extractDefinitionsFromPlainText(content, `sec${sec.num}`, definitions);
      }
    }
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.abbreviation,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    provisions,
    definitions,
  };
}

export function parseBasicLawText(text: string, act: ActIndexEntry): ParsedAct {
  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  // Basic Law format from Knesset PDF:
  // "Title label\n\n1.\n\nContent text..."
  // or "Title label\n\n1. Content text..."

  const lines = text.split('\n');
  const sections: Array<{ num: string; title: string; content: string }> = [];
  let currentSection: { num: string; title: string; content: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Detect section start: "N." at start of line
    const sectionMatch = line.match(/^(\d+[a-z]?)\.\s*(.*)/);
    if (sectionMatch) {
      // Look back for title (marginal label)
      let title = '';
      for (let j = i - 1; j >= Math.max(0, i - 4); j--) {
        const prevLine = lines[j].trim();
        if (prevLine.length > 0 && !prevLine.match(/^\d+[a-z]?\.\s/)
            && !prevLine.match(/^\(Amendment/) && prevLine.length < 100) {
          title = prevLine + (title ? ' ' + title : '');
        } else if (prevLine.length === 0 && title.length > 0) {
          break;
        }
      }

      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }

      currentSection = {
        num: sectionMatch[1],
        title: normalizeText(title),
        content: sectionMatch[2] ? normalizeText(sectionMatch[0]) : '',
      };
      continue;
    }

    // Accumulate content
    if (currentSection && line.length > 0) {
      // Skip header / footer lines
      if (line.match(/^BASIC-LAW:/i)) continue;
      if (line.match(/^This unofficial/i)) continue;
      if (line.match(/^For the full/i)) continue;
      if (line.match(/^Special thanks/i)) continue;

      currentSection.content += ' ' + normalizeText(line);
    }
  }

  if (currentSection) {
    sections.push(currentSection);
  }

  for (const sec of sections) {
    const content = normalizeText(sec.content);
    if (content.length > 10) {
      provisions.push({
        provision_ref: `sec${sec.num}`,
        chapter: undefined,
        section: sec.num,
        title: sec.title,
        content: content.substring(0, 8000),
      });
    }
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.abbreviation,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    provisions,
    definitions,
  };
}

// ---------------------------------------------------------------------------
// Definition extractors
// ---------------------------------------------------------------------------

function extractDefinitionsFromContent(
  content: string,
  sourceProvision: string,
  definitions: ParsedDefinition[],
): void {
  // Pattern: "term" - definition text; or "term" has the meaning...
  const defPattern = /["\u201c]([^"\u201d]+)["\u201d]\s*[-\u2013\u2014]\s*([^;]+(?:;|$))/g;
  let match;
  while ((match = defPattern.exec(content)) !== null) {
    const term = normalizeText(match[1]);
    const definition = normalizeText(match[2]).replace(/;$/, '').trim();
    if (term.length > 1 && term.length < 80 && definition.length > 5) {
      // Avoid duplicates
      if (!definitions.some((d) => d.term === term)) {
        definitions.push({ term, definition, source_provision: sourceProvision });
      }
    }
  }
}

function extractDefinitionsFromPlainText(
  content: string,
  sourceProvision: string,
  definitions: ParsedDefinition[],
): void {
  // Computer Law definitions format (PDF uses regular quotes):
  // "computer material" - software or information;
  // Also handle curly quotes from other sources
  const patterns = [
    /["\u201c]([^"\u201d]+)["\u201d]\s*[-\u2013\u2014]+\s*([^;]+;)/g,
    /"([^"]+)"\s*[-\u2013\u2014]+\s*([^;]+;)/g,
  ];
  const seen = new Set<string>();
  for (const defPattern of patterns) {
    let match;
    while ((match = defPattern.exec(content)) !== null) {
      const term = normalizeText(match[1]);
      const definition = normalizeText(match[2]).replace(/;$/, '').trim();
      if (term.length > 1 && term.length < 80 && definition.length > 5 && !seen.has(term)) {
        seen.add(term);
        if (!definitions.some((d) => d.term === term)) {
          definitions.push({ term, definition, source_provision: sourceProvision });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Generic HTML parser (fallback for future sources)
// ---------------------------------------------------------------------------

export function parseIsraeliLawHtml(html: string, act: ActIndexEntry): ParsedAct {
  // Route to the appropriate specific parser based on act ID
  if (act.id === 'privacy-protection-law-1981') {
    return parsePrivacyLawHtml(html, act);
  }

  // Generic fallback: try to split by bold section numbers
  const provisions: ParsedProvision[] = [];
  const definitions: ParsedDefinition[] = [];

  let currentChapter = '';
  const sectionPattern = /<B>(?:<a[^>]*><\/a>)?\s*(\d+[A-Z]?)\.\s+([^<]+)<\/B>/gi;
  const chapterPattern = /<B>\s*(CHAPTER\s+[^:]+:\s*[^<]+)<\/B>/gi;

  const chapters: Array<{ pos: number; name: string }> = [];
  let chMatch;
  while ((chMatch = chapterPattern.exec(html)) !== null) {
    chapters.push({ pos: chMatch.index, name: normalizeText(stripHtml(chMatch[1])) });
  }

  const sectionMatches: Array<{ pos: number; num: string; title: string }> = [];
  let secMatch;
  while ((secMatch = sectionPattern.exec(html)) !== null) {
    sectionMatches.push({
      pos: secMatch.index,
      num: secMatch[1].trim(),
      title: normalizeText(stripHtml(secMatch[2])),
    });
  }

  for (let i = 0; i < sectionMatches.length; i++) {
    const sec = sectionMatches[i];
    const nextSec = sectionMatches[i + 1];

    for (const ch of chapters) {
      if (ch.pos < sec.pos) currentChapter = ch.name;
    }

    const startPos = sec.pos;
    const endPos = nextSec ? nextSec.pos : html.length;
    const content = normalizeText(stripHtml(html.substring(startPos, endPos)));

    if (content.length > 10) {
      provisions.push({
        provision_ref: `sec${sec.num}`,
        chapter: currentChapter || undefined,
        section: sec.num,
        title: sec.title,
        content: content.substring(0, 8000),
      });
    }
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.abbreviation,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    provisions,
    definitions,
  };
}

// ---------------------------------------------------------------------------
// Key Israeli Acts -- updated with correct Knesset OData IDs and
// accessible English source URLs
// ---------------------------------------------------------------------------

export const KEY_ISRAELI_ACTS: ActIndexEntry[] = [
  // ═══════════════════════════════════════════════════════════════════
  // EXISTING 10 LAWS (unchanged)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'privacy-protection-law-1981',
    lawName: 'Privacy Protection Law',
    year: 1981,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d2\u05e0\u05ea \u05d4\u05e4\u05e8\u05d8\u05d9\u05d5\u05ea, \u05ea\u05e9\u05de"\u05d0-1981',
    titleEn: 'Protection of Privacy Law, 5741-1981',
    abbreviation: 'PPL',
    status: 'in_force',
    issuedDate: '1981-03-11',
    inForceDate: '1981-09-11',
    url: 'https://ics.uci.edu/~kobsa/privacy/israel.htm',
  },
  {
    id: 'data-security-regulations-2017',
    lawName: 'Protection of Privacy Regulations (Data Security)',
    year: 2017,
    title: '\u05ea\u05e7\u05e0\u05d5\u05ea \u05d4\u05d2\u05e0\u05ea \u05d4\u05e4\u05e8\u05d8\u05d9\u05d5\u05ea (\u05d0\u05d1\u05d8\u05d7\u05ea \u05de\u05d9\u05d3\u05e2), \u05ea\u05e9\u05e2"\u05d6-2017',
    titleEn: 'Protection of Privacy Regulations (Data Security), 5777-2017',
    abbreviation: 'DSR',
    status: 'in_force',
    issuedDate: '2017-03-21',
    inForceDate: '2018-05-08',
    url: 'https://www.gov.il/en/departments/legalinfo/data_security_regulation',
  },
  {
    id: 'computer-law-1995',
    lawName: 'Computers Law',
    year: 1995,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05de\u05d7\u05e9\u05d1\u05d9\u05dd, \u05ea\u05e9\u05e0"\u05d4-1995',
    titleEn: 'Computers Law, 5755-1995',
    abbreviation: 'CL',
    status: 'in_force',
    issuedDate: '1995-07-25',
    inForceDate: '1995-10-25',
    url: 'https://www.unodc.org/cld/uploads/res/document/computer-law_html/Israel_Computers_Law_5755_1995.pdf',
  },
  {
    id: 'basic-law-human-dignity-1992',
    lawName: 'Basic Law: Human Dignity and Liberty',
    year: 1992,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05db\u05d1\u05d5\u05d3 \u05d4\u05d0\u05d3\u05dd \u05d5\u05d7\u05d9\u05e8\u05d5\u05ea\u05d5',
    titleEn: 'Basic Law: Human Dignity and Liberty, 5752-1992',
    abbreviation: 'BL-HDL',
    status: 'in_force',
    issuedDate: '1992-03-17',
    inForceDate: '1992-03-17',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawLiberty.pdf',
  },
  {
    id: 'companies-law-1999',
    lawName: 'Companies Law',
    year: 1999,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d7\u05d1\u05e8\u05d5\u05ea, \u05ea\u05e9\u05e0"\u05d8-1999',
    titleEn: 'Companies Law, 5759-1999',
    abbreviation: 'CoL',
    status: 'in_force',
    issuedDate: '1999-02-15',
    inForceDate: '2000-02-01',
    url: 'https://www.gov.il/en/departments/legalinfo/companies_law',
  },
  {
    id: 'electronic-signature-law-2001',
    lawName: 'Electronic Signature Law',
    year: 2001,
    title: '\u05d7\u05d5\u05e7 \u05d7\u05ea\u05d9\u05de\u05d4 \u05d0\u05dc\u05e7\u05d8\u05e8\u05d5\u05e0\u05d9\u05ea, \u05ea\u05e1"\u05d0-2001',
    titleEn: 'Electronic Signature Law, 5761-2001',
    abbreviation: 'ESL',
    status: 'in_force',
    issuedDate: '2001-08-07',
    inForceDate: '2001-08-07',
    url: 'https://www.gov.il/en/departments/legalinfo/electronic_signature_law',
  },
  {
    id: 'credit-data-law-2002',
    lawName: 'Credit Data Law',
    year: 2002,
    title: '\u05d7\u05d5\u05e7 \u05e0\u05ea\u05d5\u05e0\u05d9 \u05d0\u05e9\u05e8\u05d0\u05d9, \u05ea\u05e1"\u05d1-2002',
    titleEn: 'Credit Data Law, 5762-2002',
    abbreviation: 'CDL',
    status: 'in_force',
    issuedDate: '2002-01-01',
    inForceDate: '2002-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_611.htm',
  },
  {
    id: 'freedom-of-information-law-1998',
    lawName: 'Freedom of Information Law',
    year: 1998,
    title: '\u05d7\u05d5\u05e7 \u05d7\u05d5\u05e4\u05e9 \u05d4\u05de\u05d9\u05d3\u05e2, \u05ea\u05e9\u05e0"\u05d7-1998',
    titleEn: 'Freedom of Information Law, 5758-1998',
    abbreviation: 'FoIL',
    status: 'in_force',
    issuedDate: '1998-05-19',
    inForceDate: '1999-05-19',
    url: 'https://www.gov.il/en/departments/legalinfo/freedom_of_information_law',
  },
  {
    id: 'regulation-of-security-1998',
    lawName: 'Regulation of Security in Public Bodies Law',
    year: 1998,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05e1\u05d3\u05e8\u05ea \u05d4\u05d0\u05d1\u05d8\u05d7\u05d4 \u05d1\u05d2\u05d5\u05e4\u05d9\u05dd \u05e6\u05d9\u05d1\u05d5\u05e8\u05d9\u05d9\u05dd, \u05ea\u05e9\u05e0"\u05d7-1998',
    titleEn: 'Regulation of Security in Public Bodies Law, 5758-1998',
    abbreviation: 'RSPBL',
    status: 'in_force',
    issuedDate: '1998-01-01',
    inForceDate: '1998-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_574.htm',
  },
  {
    id: 'communications-law-1982',
    lawName: 'Communications Law (Telecommunications and Broadcasting)',
    year: 1982,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05ea\u05e7\u05e9\u05d5\u05e8\u05ea (\u05d1\u05d6\u05e7 \u05d5\u05e9\u05d9\u05d3\u05d5\u05e8\u05d9\u05dd), \u05ea\u05e9\u05de"\u05d1-1982',
    titleEn: 'Communications Law (Telecommunications and Broadcasting), 5742-1982',
    abbreviation: 'CommL',
    status: 'in_force',
    issuedDate: '1982-01-01',
    inForceDate: '1984-02-01',
    url: 'https://www.nevo.co.il/law_html/law01/044_001.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: 10 BASIC LAWS (Knesset PDF sources)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'basic-law-the-knesset-1958',
    lawName: 'Basic Law: The Knesset',
    year: 1958,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d4\u05db\u05e0\u05e1\u05ea',
    titleEn: 'Basic Law: The Knesset, 5718-1958',
    abbreviation: 'BL-KNS',
    status: 'in_force',
    issuedDate: '1958-02-12',
    inForceDate: '1958-02-12',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawTheKnesset.pdf',
  },
  {
    id: 'basic-law-israel-lands-1960',
    lawName: 'Basic Law: Israel Lands',
    year: 1960,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05de\u05e7\u05e8\u05e7\u05e2\u05d9 \u05d9\u05e9\u05e8\u05d0\u05dc',
    titleEn: 'Basic Law: Israel Lands, 5720-1960',
    abbreviation: 'BL-IL',
    status: 'in_force',
    issuedDate: '1960-07-25',
    inForceDate: '1960-07-25',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawIsraelLands.pdf',
  },
  {
    id: 'basic-law-the-president-1964',
    lawName: 'Basic Law: The President of the State',
    year: 1964,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05e0\u05e9\u05d9\u05d0 \u05d4\u05de\u05d3\u05d9\u05e0\u05d4',
    titleEn: 'Basic Law: The President of the State, 5724-1964',
    abbreviation: 'BL-PRES',
    status: 'in_force',
    issuedDate: '1964-06-16',
    inForceDate: '1964-06-16',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawThePresident.pdf',
  },
  {
    id: 'basic-law-the-government-2001',
    lawName: 'Basic Law: The Government',
    year: 2001,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d4\u05de\u05de\u05e9\u05dc\u05d4',
    titleEn: 'Basic Law: The Government, 5761-2001',
    abbreviation: 'BL-GOV',
    status: 'in_force',
    issuedDate: '2001-03-07',
    inForceDate: '2001-03-07',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawTheGovernment.pdf',
  },
  {
    id: 'basic-law-the-state-economy-1975',
    lawName: 'Basic Law: The State Economy',
    year: 1975,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05de\u05e9\u05e7 \u05d4\u05de\u05d3\u05d9\u05e0\u05d4',
    titleEn: 'Basic Law: The State Economy, 5735-1975',
    abbreviation: 'BL-ECON',
    status: 'in_force',
    issuedDate: '1975-07-21',
    inForceDate: '1975-07-21',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawStateEconomy.pdf',
  },
  {
    id: 'basic-law-the-judiciary-1984',
    lawName: 'Basic Law: The Judiciary',
    year: 1984,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d4\u05e9\u05e4\u05d9\u05d8\u05d4',
    titleEn: 'Basic Law: The Judiciary, 5744-1984',
    abbreviation: 'BL-JUD',
    status: 'in_force',
    issuedDate: '1984-02-28',
    inForceDate: '1984-02-28',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawTheJudiciary.pdf',
  },
  {
    id: 'basic-law-jerusalem-1980',
    lawName: 'Basic Law: Jerusalem, Capital of Israel',
    year: 1980,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d9\u05e8\u05d5\u05e9\u05dc\u05d9\u05dd \u05d1\u05d9\u05e8\u05ea \u05d9\u05e9\u05e8\u05d0\u05dc',
    titleEn: 'Basic Law: Jerusalem, Capital of Israel, 5740-1980',
    abbreviation: 'BL-JER',
    status: 'in_force',
    issuedDate: '1980-07-30',
    inForceDate: '1980-07-30',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawJerusalem.pdf',
  },
  {
    id: 'basic-law-freedom-of-occupation-1994',
    lawName: 'Basic Law: Freedom of Occupation',
    year: 1994,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d7\u05d5\u05e4\u05e9 \u05d4\u05e2\u05d9\u05e1\u05d5\u05e7',
    titleEn: 'Basic Law: Freedom of Occupation, 5754-1994',
    abbreviation: 'BL-FOO',
    status: 'in_force',
    issuedDate: '1994-03-09',
    inForceDate: '1994-03-09',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawOccupation.pdf',
  },
  {
    id: 'basic-law-referendum-2014',
    lawName: 'Basic Law: Referendum',
    year: 2014,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05de\u05e9\u05d0\u05dc \u05e2\u05dd',
    titleEn: 'Basic Law: Referendum, 5774-2014',
    abbreviation: 'BL-REF',
    status: 'in_force',
    issuedDate: '2014-03-12',
    inForceDate: '2014-03-12',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawReferendum.pdf',
  },
  {
    id: 'basic-law-nation-state-2018',
    lawName: 'Basic Law: Israel - The Nation State of the Jewish People',
    year: 2018,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d9\u05e9\u05e8\u05d0\u05dc \u2013 \u05de\u05d3\u05d9\u05e0\u05ea \u05d4\u05dc\u05d0\u05d5\u05dd \u05e9\u05dc \u05d4\u05e2\u05dd \u05d4\u05d9\u05d4\u05d5\u05d3\u05d9',
    titleEn: 'Basic Law: Israel - The Nation State of the Jewish People, 5778-2018',
    abbreviation: 'BL-NS',
    status: 'in_force',
    issuedDate: '2018-07-19',
    inForceDate: '2018-07-19',
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawNationState.pdf',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: 2 REMAINING BASIC LAWS (metadata-only, no accessible PDF)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'basic-law-the-army-1976',
    lawName: 'Basic Law: The Military',
    year: 1976,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d4\u05e6\u05d1\u05d0',
    titleEn: 'Basic Law: The Military, 5736-1976',
    abbreviation: 'BL-MIL',
    status: 'in_force',
    issuedDate: '1976-04-01',
    inForceDate: '1976-04-01',
    url: 'https://www.knesset.gov.il/laws/special/eng/BasicLawArmy.pdf',
  },
  {
    id: 'basic-law-legislation-2001',
    lawName: 'Basic Law: Legislation',
    year: 2001,
    title: '\u05d7\u05d5\u05e7 \u05d9\u05e1\u05d5\u05d3: \u05d7\u05e7\u05d9\u05e7\u05d4',
    titleEn: 'Basic Law: Legislation (draft — not yet enacted)',
    abbreviation: 'BL-LEG',
    status: 'not_yet_in_force',
    issuedDate: '2001-01-01',
    inForceDate: '2001-01-01',
    url: 'https://www.knesset.gov.il/laws/special/eng/BasicLawLegislation.pdf',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: FINANCIAL & SECURITIES LAWS (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'securities-law-1968',
    lawName: 'Securities Law',
    year: 1968,
    title: '\u05d7\u05d5\u05e7 \u05e0\u05d9\u05d9\u05e8\u05d5\u05ea \u05e2\u05e8\u05da, \u05ea\u05e9\u05db"\u05d7-1968',
    titleEn: 'Securities Law, 5728-1968',
    abbreviation: 'SecL',
    status: 'in_force',
    issuedDate: '1968-08-20',
    inForceDate: '1968-08-20',
    url: 'https://www.nevo.co.il/law_html/law01/055_001.htm',
  },
  {
    id: 'banking-ordinance-1941',
    lawName: 'Banking Ordinance',
    year: 1941,
    title: '\u05e4\u05e7\u05d5\u05d3\u05ea \u05d4\u05d1\u05e0\u05e7\u05d0\u05d5\u05ea, 1941',
    titleEn: 'Banking Ordinance, 1941',
    abbreviation: 'BO',
    status: 'in_force',
    issuedDate: '1941-01-01',
    inForceDate: '1941-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/p187_001.htm',
  },
  {
    id: 'banking-licensing-law-1981',
    lawName: 'Banking (Licensing) Law',
    year: 1981,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d1\u05e0\u05e7\u05d0\u05d5\u05ea (\u05e8\u05d9\u05e9\u05d5\u05d9), \u05ea\u05e9\u05de"\u05d0-1981',
    titleEn: 'Banking (Licensing) Law, 5741-1981',
    abbreviation: 'BLL',
    status: 'in_force',
    issuedDate: '1981-01-01',
    inForceDate: '1981-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_076.htm',
  },
  {
    id: 'insurance-business-law-1981',
    lawName: 'Insurance Business (Control) Law',
    year: 1981,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7 \u05e2\u05dc \u05e2\u05e1\u05e7\u05d9 \u05d1\u05d9\u05d8\u05d5\u05d7, \u05ea\u05e9\u05de"\u05d0-1981',
    titleEn: 'Insurance Business (Control) Law, 5741-1981',
    abbreviation: 'IBL',
    status: 'in_force',
    issuedDate: '1981-01-01',
    inForceDate: '1981-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_079.htm',
  },
  {
    id: 'anti-money-laundering-law-2000',
    lawName: 'Prohibition of Money Laundering Law',
    year: 2000,
    title: '\u05d7\u05d5\u05e7 \u05d0\u05d9\u05e1\u05d5\u05e8 \u05d4\u05dc\u05d1\u05e0\u05ea \u05d4\u05d5\u05df, \u05ea\u05e9"\u05e1-2000',
    titleEn: 'Prohibition of Money Laundering Law, 5760-2000',
    abbreviation: 'AML',
    status: 'in_force',
    issuedDate: '2000-08-03',
    inForceDate: '2002-02-17',
    url: 'https://www.nevo.co.il/law_html/law01/999_207.htm',
  },
  {
    id: 'terror-financing-prohibition-law-2005',
    lawName: 'Prohibition on Terror Financing Law',
    year: 2005,
    title: '\u05d7\u05d5\u05e7 \u05d0\u05d9\u05e1\u05d5\u05e8 \u05de\u05d9\u05de\u05d5\u05df \u05d8\u05e8\u05d5\u05e8, \u05ea\u05e9\u05e1"\u05d4-2005',
    titleEn: 'Prohibition on Terror Financing Law, 5765-2005',
    abbreviation: 'TFL',
    status: 'in_force',
    issuedDate: '2005-01-01',
    inForceDate: '2005-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_627.htm',
  },
  {
    id: 'financial-services-regulation-law-2005',
    lawName: 'Financial Services Regulation (Financial Services) Law',
    year: 2005,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7 \u05e2\u05dc \u05e9\u05d9\u05e8\u05d5\u05ea\u05d9\u05dd \u05e4\u05d9\u05e0\u05e0\u05e1\u05d9\u05d9\u05dd, \u05ea\u05e9\u05e1"\u05d4-2005',
    titleEn: 'Financial Services Regulation (Financial Services) Law, 5765-2005',
    abbreviation: 'FSRL',
    status: 'in_force',
    issuedDate: '2005-01-01',
    inForceDate: '2005-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_629.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: INTELLECTUAL PROPERTY LAWS (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'patent-law-1967',
    lawName: 'Patents Law',
    year: 1967,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05e4\u05d8\u05e0\u05d8\u05d9\u05dd, \u05ea\u05e9\u05db"\u05d6-1967',
    titleEn: 'Patents Law, 5727-1967',
    abbreviation: 'PatL',
    status: 'in_force',
    issuedDate: '1967-04-04',
    inForceDate: '1968-04-04',
    url: 'https://www.nevo.co.il/law_html/law01/050_001.htm',
  },
  {
    id: 'copyright-law-2007',
    lawName: 'Copyright Law',
    year: 2007,
    title: '\u05d7\u05d5\u05e7 \u05d6\u05db\u05d5\u05ea \u05d9\u05d5\u05e6\u05e8\u05d9\u05dd, \u05ea\u05e9\u05e1"\u05d7-2007',
    titleEn: 'Copyright Law, 5768-2007',
    abbreviation: 'CopyL',
    status: 'in_force',
    issuedDate: '2007-11-19',
    inForceDate: '2008-05-25',
    url: 'https://www.nevo.co.il/law_html/law01/999_701.htm',
  },
  {
    id: 'trademarks-ordinance-1972',
    lawName: 'Trademarks Ordinance (New Version)',
    year: 1972,
    title: '\u05e4\u05e7\u05d5\u05d3\u05ea \u05e1\u05d9\u05de\u05e0\u05d9 \u05de\u05e1\u05d7\u05e8 [\u05e0\u05d5\u05e1\u05d7 \u05d7\u05d3\u05e9], \u05ea\u05e9\u05dc"\u05d1-1972',
    titleEn: 'Trademarks Ordinance (New Version), 5732-1972',
    abbreviation: 'TMO',
    status: 'in_force',
    issuedDate: '1972-01-01',
    inForceDate: '1972-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/p233_001.htm',
  },
  {
    id: 'trade-secrets-law-1999',
    lawName: 'Trade Secrets Law',
    year: 1999,
    title: '\u05d7\u05d5\u05e7 \u05e2\u05d5\u05d5\u05dc\u05d5\u05ea \u05de\u05e1\u05d7\u05e8\u05d9\u05d5\u05ea, \u05ea\u05e9\u05e0"\u05d9-1999',
    titleEn: 'Trade Secrets Law, 5759-1999',
    abbreviation: 'TSL',
    status: 'in_force',
    issuedDate: '1999-02-01',
    inForceDate: '1999-02-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_571.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: LABOR & EMPLOYMENT LAWS (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'employment-law-1959',
    lawName: 'Employment Service Law',
    year: 1959,
    title: '\u05d7\u05d5\u05e7 \u05e9\u05d9\u05e8\u05d5\u05ea \u05d4\u05ea\u05e2\u05e1\u05d5\u05e7\u05d4, \u05ea\u05e9\u05d9"\u05d8-1959',
    titleEn: 'Employment Service Law, 5719-1959',
    abbreviation: 'EmSL',
    status: 'in_force',
    issuedDate: '1959-01-01',
    inForceDate: '1959-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/017_002.htm',
  },
  {
    id: 'hours-of-work-and-rest-law-1951',
    lawName: 'Hours of Work and Rest Law',
    year: 1951,
    title: '\u05d7\u05d5\u05e7 \u05e9\u05e2\u05d5\u05ea \u05e2\u05d1\u05d5\u05d3\u05d4 \u05d5\u05de\u05e0\u05d5\u05d7\u05d4, \u05ea\u05e9\u05d9"\u05d0-1951',
    titleEn: 'Hours of Work and Rest Law, 5711-1951',
    abbreviation: 'HWRL',
    status: 'in_force',
    issuedDate: '1951-06-11',
    inForceDate: '1951-06-11',
    url: 'https://www.nevo.co.il/law_html/law01/007_001.htm',
  },
  {
    id: 'annual-leave-law-1951',
    lawName: 'Annual Leave Law',
    year: 1951,
    title: '\u05d7\u05d5\u05e7 \u05d7\u05d5\u05e4\u05e9\u05d4 \u05e9\u05e0\u05ea\u05d9\u05ea, \u05ea\u05e9\u05d9"\u05d0-1951',
    titleEn: 'Annual Leave Law, 5711-1951',
    abbreviation: 'ALL',
    status: 'in_force',
    issuedDate: '1951-06-11',
    inForceDate: '1951-06-11',
    url: 'https://www.nevo.co.il/law_html/law01/007_002.htm',
  },
  {
    id: 'severance-pay-law-1963',
    lawName: 'Severance Pay Law',
    year: 1963,
    title: '\u05d7\u05d5\u05e7 \u05e4\u05d9\u05e6\u05d5\u05d9\u05d9\u05dd, \u05ea\u05e9\u05db"\u05d2-1963',
    titleEn: 'Severance Pay Law, 5723-1963',
    abbreviation: 'SPL',
    status: 'in_force',
    issuedDate: '1963-01-01',
    inForceDate: '1963-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/035_001.htm',
  },
  {
    id: 'employment-equal-opportunities-law-1988',
    lawName: 'Employment (Equal Opportunities) Law',
    year: 1988,
    title: '\u05d7\u05d5\u05e7 \u05e9\u05d5\u05d5\u05d9\u05d5\u05df \u05d4\u05d6\u05d3\u05de\u05e0\u05d5\u05d9\u05d5\u05ea \u05d1\u05e2\u05d1\u05d5\u05d3\u05d4, \u05ea\u05e9\u05de"\u05d7-1988',
    titleEn: 'Employment (Equal Opportunities) Law, 5748-1988',
    abbreviation: 'EEOL',
    status: 'in_force',
    issuedDate: '1988-03-01',
    inForceDate: '1988-03-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_138.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: CONSUMER & CONTRACT LAW (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'consumer-protection-law-1981',
    lawName: 'Consumer Protection Law',
    year: 1981,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d2\u05e0\u05ea \u05d4\u05e6\u05e8\u05db\u05df, \u05ea\u05e9\u05de"\u05d0-1981',
    titleEn: 'Consumer Protection Law, 5741-1981',
    abbreviation: 'CPL',
    status: 'in_force',
    issuedDate: '1981-03-12',
    inForceDate: '1981-09-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_075.htm',
  },
  {
    id: 'standard-contracts-law-1982',
    lawName: 'Standard Contracts Law',
    year: 1982,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d7\u05d5\u05d6\u05d9\u05dd \u05d4\u05d0\u05d7\u05d9\u05d3\u05d9\u05dd, \u05ea\u05e9\u05de"\u05d1-1982',
    titleEn: 'Standard Contracts Law, 5743-1982',
    abbreviation: 'SCL',
    status: 'in_force',
    issuedDate: '1982-11-15',
    inForceDate: '1983-05-15',
    url: 'https://www.nevo.co.il/law_html/law01/999_093.htm',
  },
  {
    id: 'contracts-general-part-law-1973',
    lawName: 'Contracts (General Part) Law',
    year: 1973,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d7\u05d5\u05d6\u05d9\u05dd (\u05d7\u05dc\u05e7 \u05db\u05dc\u05dc\u05d9), \u05ea\u05e9\u05dc"\u05d3-1973',
    titleEn: 'Contracts (General Part) Law, 5733-1973',
    abbreviation: 'CGL',
    status: 'in_force',
    issuedDate: '1973-04-10',
    inForceDate: '1973-04-10',
    url: 'https://www.nevo.co.il/law_html/law01/067_001.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: PROCEDURAL LAW (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'evidence-ordinance-1971',
    lawName: 'Evidence Ordinance (New Version)',
    year: 1971,
    title: '\u05e4\u05e7\u05d5\u05d3\u05ea \u05d4\u05e8\u05d0\u05d9\u05d5\u05ea [\u05e0\u05d5\u05e1\u05d7 \u05d7\u05d3\u05e9], \u05ea\u05e9\u05dc"\u05d0-1971',
    titleEn: 'Evidence Ordinance (New Version), 5731-1971',
    abbreviation: 'EO',
    status: 'in_force',
    issuedDate: '1971-01-01',
    inForceDate: '1971-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/p232_001.htm',
  },
  {
    id: 'courts-law-1984',
    lawName: 'Courts Law (Consolidated Version)',
    year: 1984,
    title: '\u05d7\u05d5\u05e7 \u05d1\u05ea\u05d9 \u05d4\u05de\u05e9\u05e4\u05d8 [\u05e0\u05d5\u05e1\u05d7 \u05de\u05e9\u05d5\u05dc\u05d1], \u05ea\u05e9\u05de"\u05d3-1984',
    titleEn: 'Courts Law (Consolidated Version), 5744-1984',
    abbreviation: 'CtL',
    status: 'in_force',
    issuedDate: '1984-01-01',
    inForceDate: '1984-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_104.htm',
  },
  {
    id: 'criminal-procedure-law-1982',
    lawName: 'Criminal Procedure Law (Consolidated Version)',
    year: 1982,
    title: '\u05d7\u05d5\u05e7 \u05e1\u05d3\u05e8 \u05d4\u05d3\u05d9\u05df \u05d4\u05e4\u05dc\u05d9\u05dc\u05d9 [\u05e0\u05d5\u05e1\u05d7 \u05de\u05e9\u05d5\u05dc\u05d1], \u05ea\u05e9\u05de"\u05d1-1982',
    titleEn: 'Criminal Procedure Law (Consolidated Version), 5742-1982',
    abbreviation: 'CrimPL',
    status: 'in_force',
    issuedDate: '1982-01-01',
    inForceDate: '1982-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_092.htm',
  },
  {
    id: 'civil-procedure-regulations-1984',
    lawName: 'Civil Procedure Regulations',
    year: 1984,
    title: '\u05ea\u05e7\u05e0\u05d5\u05ea \u05e1\u05d3\u05e8 \u05d4\u05d3\u05d9\u05df \u05d4\u05d0\u05d6\u05e8\u05d7\u05d9, \u05ea\u05e9\u05de"\u05d3-1984',
    titleEn: 'Civil Procedure Regulations, 5744-1984',
    abbreviation: 'CPR',
    status: 'in_force',
    issuedDate: '1984-01-01',
    inForceDate: '1984-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_103.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: CRIMINAL LAW (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'penal-law-1977',
    lawName: 'Penal Law',
    year: 1977,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05e2\u05d5\u05e0\u05e9\u05d9\u05df, \u05ea\u05e9\u05dc"\u05d6-1977',
    titleEn: 'Penal Law, 5737-1977',
    abbreviation: 'PL',
    status: 'in_force',
    issuedDate: '1977-08-04',
    inForceDate: '1977-08-04',
    url: 'https://www.nevo.co.il/law_html/law01/073_002.htm',
  },
  {
    id: 'wiretapping-law-1979',
    lawName: 'Wiretapping Law',
    year: 1979,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d0\u05d6\u05e0\u05ea \u05e1\u05ea\u05e8, \u05ea\u05e9\u05dc"\u05d8-1979',
    titleEn: 'Wiretapping Law, 5739-1979',
    abbreviation: 'WL',
    status: 'in_force',
    issuedDate: '1979-01-01',
    inForceDate: '1979-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/073_008.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: PLANNING, ENVIRONMENT & INFRASTRUCTURE (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'planning-and-building-law-1965',
    lawName: 'Planning and Building Law',
    year: 1965,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05ea\u05db\u05e0\u05d5\u05df \u05d5\u05d4\u05d1\u05e0\u05d9\u05d9\u05d4, \u05ea\u05e9\u05db"\u05d5-1965',
    titleEn: 'Planning and Building Law, 5725-1965',
    abbreviation: 'PBL',
    status: 'in_force',
    issuedDate: '1965-06-26',
    inForceDate: '1966-09-12',
    url: 'https://www.nevo.co.il/law_html/law01/042_001.htm',
  },
  {
    id: 'environmental-protection-law-2008',
    lawName: 'Clean Air Law',
    year: 2008,
    title: '\u05d7\u05d5\u05e7 \u05d0\u05d5\u05d5\u05d9\u05e8 \u05e0\u05e7\u05d9, \u05ea\u05e9\u05e1"\u05d7-2008',
    titleEn: 'Clean Air Law, 5768-2008',
    abbreviation: 'CAL',
    status: 'in_force',
    issuedDate: '2008-07-29',
    inForceDate: '2011-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_723.htm',
  },
  {
    id: 'hazardous-substances-law-1993',
    lawName: 'Hazardous Substances Law',
    year: 1993,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d7\u05d5\u05de\u05e8\u05d9\u05dd \u05d4\u05de\u05e1\u05d5\u05db\u05e0\u05d9\u05dd, \u05ea\u05e9\u05e0"\u05d2-1993',
    titleEn: 'Hazardous Substances Law, 5753-1993',
    abbreviation: 'HSL',
    status: 'in_force',
    issuedDate: '1993-01-01',
    inForceDate: '1993-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_285.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: TELECOMMUNICATIONS & POSTAL (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'postal-law-1986',
    lawName: 'Postal Authority Law',
    year: 1986,
    title: '\u05d7\u05d5\u05e7 \u05e8\u05e9\u05d5\u05ea \u05d4\u05d3\u05d5\u05d0\u05e8, \u05ea\u05e9\u05de"\u05d6-1986',
    titleEn: 'Postal Authority Law, 5746-1986',
    abbreviation: 'PAL',
    status: 'in_force',
    issuedDate: '1986-01-01',
    inForceDate: '1987-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_120.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: TORT & LIABILITY (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'civil-wrongs-ordinance-1968',
    lawName: 'Civil Wrongs Ordinance (New Version)',
    year: 1968,
    title: '\u05e4\u05e7\u05d5\u05d3\u05ea \u05d4\u05e0\u05d6\u05d9\u05e7\u05d9\u05df [\u05e0\u05d5\u05e1\u05d7 \u05d7\u05d3\u05e9], \u05ea\u05e9\u05db"\u05d8-1968',
    titleEn: 'Civil Wrongs Ordinance (New Version), 5728-1968',
    abbreviation: 'CWO',
    status: 'in_force',
    issuedDate: '1968-01-01',
    inForceDate: '1968-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/p230_001.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: NATIONAL SECURITY & DEFENSE (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'defense-service-law-1986',
    lawName: 'Defense Service Law (Consolidated Version)',
    year: 1986,
    title: '\u05d7\u05d5\u05e7 \u05e9\u05d9\u05e8\u05d5\u05ea \u05d1\u05d9\u05d8\u05d7\u05d5\u05df [\u05e0\u05d5\u05e1\u05d7 \u05de\u05e9\u05d5\u05dc\u05d1], \u05ea\u05e9\u05de"\u05d6-1986',
    titleEn: 'Defense Service Law (Consolidated Version), 5746-1986',
    abbreviation: 'DSL',
    status: 'in_force',
    issuedDate: '1986-01-01',
    inForceDate: '1986-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_114.htm',
  },
  {
    id: 'cyber-defense-law-2016',
    lawName: 'Regulation of Security in Public Bodies (Cyber Defense Directive)',
    year: 2016,
    title: '\u05d4\u05e0\u05d7\u05d9\u05d9\u05ea \u05e8\u05e9\u05d5\u05ea \u05d4\u05e1\u05d9\u05d9\u05d1\u05e8 \u05d4\u05dc\u05d0\u05d5\u05de\u05d9 \u05dc\u05d4\u05d2\u05e0\u05ea \u05d4\u05e1\u05d9\u05d9\u05d1\u05e8 \u05d1\u05d2\u05d5\u05e4\u05d9\u05dd \u05e6\u05d9\u05d1\u05d5\u05e8\u05d9\u05d9\u05dd',
    titleEn: 'National Cyber Directorate - Cyber Defense Directive for Public Bodies, 2016',
    abbreviation: 'CDD',
    status: 'in_force',
    issuedDate: '2016-02-14',
    inForceDate: '2016-02-14',
    url: 'https://www.gov.il/en/departments/news/14022016_01',
  },
  {
    id: 'emergency-powers-detention-law-1979',
    lawName: 'Emergency Powers (Detention) Law',
    year: 1979,
    title: '\u05d7\u05d5\u05e7 \u05e1\u05de\u05db\u05d5\u05d9\u05d5\u05ea \u05e9\u05e2\u05ea \u05d7\u05d9\u05e8\u05d5\u05dd (\u05de\u05e2\u05e6\u05e8\u05d9\u05dd), \u05ea\u05e9\u05dc"\u05d9-1979',
    titleEn: 'Emergency Powers (Detention) Law, 5739-1979',
    abbreviation: 'EPDL',
    status: 'in_force',
    issuedDate: '1979-01-01',
    inForceDate: '1979-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/073_006.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: ADMINISTRATIVE & PUBLIC LAW (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'administrative-courts-law-2000',
    lawName: 'Administrative Courts Law',
    year: 2000,
    title: '\u05d7\u05d5\u05e7 \u05d1\u05ea\u05d9 \u05de\u05e9\u05e4\u05d8 \u05dc\u05e2\u05e0\u05d9\u05d9\u05e0\u05d9\u05dd \u05de\u05d9\u05e0\u05d4\u05dc\u05d9\u05d9\u05dd, \u05ea\u05e9"\u05e1-2000',
    titleEn: 'Administrative Courts Law, 5760-2000',
    abbreviation: 'ACL',
    status: 'in_force',
    issuedDate: '2000-07-25',
    inForceDate: '2004-09-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_206.htm',
  },
  {
    id: 'government-companies-law-1975',
    lawName: 'Government Companies Law',
    year: 1975,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05d7\u05d1\u05e8\u05d5\u05ea \u05d4\u05de\u05de\u05e9\u05dc\u05ea\u05d9\u05d5\u05ea, \u05ea\u05e9\u05dc"\u05d5-1975',
    titleEn: 'Government Companies Law, 5735-1975',
    abbreviation: 'GCL',
    status: 'in_force',
    issuedDate: '1975-08-04',
    inForceDate: '1975-08-04',
    url: 'https://www.nevo.co.il/law_html/law01/070_001.htm',
  },
  {
    id: 'state-comptroller-law-1958',
    lawName: 'State Comptroller Law',
    year: 1958,
    title: '\u05d7\u05d5\u05e7 \u05de\u05d1\u05e7\u05e8 \u05d4\u05de\u05d3\u05d9\u05e0\u05d4, \u05ea\u05e9\u05d9"\u05d8-1958',
    titleEn: 'State Comptroller Law, 5718-1958 (Consolidated Version)',
    abbreviation: 'StCL',
    status: 'in_force',
    issuedDate: '1958-01-01',
    inForceDate: '1958-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/016_001.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: HEALTH & MEDICAL LAW (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'patients-rights-law-1996',
    lawName: 'Patient\'s Rights Law',
    year: 1996,
    title: '\u05d7\u05d5\u05e7 \u05d6\u05db\u05d5\u05d9\u05d5\u05ea \u05d4\u05d7\u05d5\u05dc\u05d4, \u05ea\u05e9\u05e0"\u05d6-1996',
    titleEn: 'Patient\'s Rights Law, 5756-1996',
    abbreviation: 'PRL',
    status: 'in_force',
    issuedDate: '1996-05-01',
    inForceDate: '1996-05-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_529.htm',
  },
  {
    id: 'national-health-insurance-law-1994',
    lawName: 'National Health Insurance Law',
    year: 1994,
    title: '\u05d7\u05d5\u05e7 \u05d1\u05d9\u05d8\u05d5\u05d7 \u05d1\u05e8\u05d9\u05d0\u05d5\u05ea \u05de\u05de\u05dc\u05db\u05ea\u05d9, \u05ea\u05e9\u05e0"\u05d3-1994',
    titleEn: 'National Health Insurance Law, 5754-1994',
    abbreviation: 'NHIL',
    status: 'in_force',
    issuedDate: '1994-06-26',
    inForceDate: '1995-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_289.htm',
  },
  {
    id: 'genetic-information-law-2000',
    lawName: 'Genetic Information Law',
    year: 2000,
    title: '\u05d7\u05d5\u05e7 \u05de\u05d9\u05d3\u05e2 \u05d2\u05e0\u05d8\u05d9, \u05ea\u05e9"\u05e1-2000',
    titleEn: 'Genetic Information Law, 5761-2000',
    abbreviation: 'GIL',
    status: 'in_force',
    issuedDate: '2000-12-25',
    inForceDate: '2001-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_211.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: COMPETITION & REGULATORY (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'economic-competition-law-1988',
    lawName: 'Economic Competition Law (Restrictive Trade Practices)',
    year: 1988,
    title: '\u05d7\u05d5\u05e7 \u05d4\u05ea\u05d7\u05e8\u05d5\u05ea \u05d4\u05db\u05dc\u05db\u05dc\u05d9\u05ea, \u05ea\u05e9\u05de"\u05d8-1988',
    titleEn: 'Economic Competition Law, 5748-1988',
    abbreviation: 'ECL',
    status: 'in_force',
    issuedDate: '1988-01-01',
    inForceDate: '1988-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_156.htm',
  },
  {
    id: 'taxation-ordinance-1961',
    lawName: 'Income Tax Ordinance (New Version)',
    year: 1961,
    title: '\u05e4\u05e7\u05d5\u05d3\u05ea \u05de\u05e1 \u05d4\u05db\u05e0\u05e1\u05d4 [\u05e0\u05d5\u05e1\u05d7 \u05d7\u05d3\u05e9], \u05ea\u05e9\u05db"\u05d0-1961',
    titleEn: 'Income Tax Ordinance (New Version), 5721-1961',
    abbreviation: 'ITO',
    status: 'in_force',
    issuedDate: '1961-01-01',
    inForceDate: '1961-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/p222_001.htm',
  },

  // ═══════════════════════════════════════════════════════════════════
  // NEW: DATA & TECHNOLOGY (metadata-only)
  // ═══════════════════════════════════════════════════════════════════
  {
    id: 'database-registration-regulations-1986',
    lawName: 'Protection of Privacy (Registration of Databases) Regulations',
    year: 1986,
    title: '\u05ea\u05e7\u05e0\u05d5\u05ea \u05d4\u05d2\u05e0\u05ea \u05d4\u05e4\u05e8\u05d8\u05d9\u05d5\u05ea (\u05e8\u05d9\u05e9\u05d5\u05dd \u05de\u05d0\u05d2\u05e8\u05d9 \u05de\u05d9\u05d3\u05e2), \u05ea\u05e9\u05de"\u05d6-1986',
    titleEn: 'Protection of Privacy (Registration of Databases) Regulations, 5746-1986',
    abbreviation: 'DBRR',
    status: 'in_force',
    issuedDate: '1986-01-01',
    inForceDate: '1986-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_121.htm',
  },
  {
    id: 'privacy-protection-transfer-abroad-regulations-2001',
    lawName: 'Protection of Privacy (Transfer of Data to Databases Abroad) Regulations',
    year: 2001,
    title: '\u05ea\u05e7\u05e0\u05d5\u05ea \u05d4\u05d2\u05e0\u05ea \u05d4\u05e4\u05e8\u05d8\u05d9\u05d5\u05ea (\u05d4\u05e2\u05d1\u05e8\u05ea \u05de\u05d9\u05d3\u05e2 \u05dc\u05de\u05d0\u05d2\u05e8\u05d9 \u05de\u05d9\u05d3\u05e2 \u05e9\u05de\u05d7\u05d5\u05e5 \u05dc\u05d9\u05e9\u05e8\u05d0\u05dc), \u05ea\u05e1"\u05d0-2001',
    titleEn: 'Protection of Privacy (Transfer of Data to Databases Abroad) Regulations, 5761-2001',
    abbreviation: 'DTBR',
    status: 'in_force',
    issuedDate: '2001-01-01',
    inForceDate: '2001-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_609.htm',
  },
  {
    id: 'encouragement-of-research-law-1984',
    lawName: 'Encouragement of Research, Development and Technological Innovation in Industry Law',
    year: 1984,
    title: '\u05d7\u05d5\u05e7 \u05dc\u05e2\u05d9\u05d3\u05d5\u05d3 \u05de\u05d7\u05e7\u05e8 \u05d5\u05e4\u05d9\u05ea\u05d5\u05d7 \u05d5\u05d7\u05d3\u05e9\u05e0\u05d5\u05ea \u05d8\u05db\u05e0\u05d5\u05dc\u05d5\u05d2\u05d9\u05ea \u05d1\u05ea\u05e2\u05e9\u05d9\u05d9\u05d4, \u05ea\u05e9\u05de"\u05d3-1984',
    titleEn: 'Encouragement of Research, Development and Technological Innovation in Industry Law, 5744-1984',
    abbreviation: 'RDTL',
    status: 'in_force',
    issuedDate: '1984-12-10',
    inForceDate: '1985-01-01',
    url: 'https://www.nevo.co.il/law_html/law01/999_101.htm',
  },
];
