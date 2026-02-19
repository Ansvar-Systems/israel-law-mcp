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
];
