/**
 * Multi-source fetcher for Israeli legislation.
 *
 * Sources (in priority order):
 * 1. Knesset OData API     -- structured metadata (always accessible)
 * 2. Accessible English PDFs -- UNODC, Knesset mobile PDFs
 * 3. Accessible HTML pages  -- UCI mirror, etc.
 *
 * gov.il and nevo.co.il are Cloudflare-blocked for automated access;
 * knesset.gov.il HTML pages use bot protection. We therefore use the
 * OData API (no bot protection) for metadata and known accessible
 * mirrors for the actual law text.
 *
 * - 500ms minimum delay between requests
 * - User-Agent header identifying the MCP
 * - No auth needed (Government Open Data / public mirrors)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const USER_AGENT =
  'Israel-Law-MCP/1.0 (https://github.com/Ansvar-Systems/israel-law-mcp; hello@ansvar.ai)';
const MIN_DELAY_MS = 500;

let lastRequestTime = 0;

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_DELAY_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

export interface FetchResult {
  status: number;
  body: string;
  contentType: string;
}

// ---------------------------------------------------------------------------
// Generic HTTP fetch with rate limiting + retries
// ---------------------------------------------------------------------------

export async function fetchWithRateLimit(
  url: string,
  maxRetries = 3,
): Promise<FetchResult> {
  await rateLimit();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html, application/xhtml+xml, application/json, application/pdf, */*',
        },
        redirect: 'follow',
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const backoff = Math.pow(2, attempt + 1) * 1000;
          console.log(`  HTTP ${response.status} for ${url}, retrying in ${backoff}ms...`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
      }

      const body = await response.text();
      return {
        status: response.status,
        body,
        contentType: response.headers.get('content-type') ?? '',
      };
    } catch (err) {
      if (attempt < maxRetries) {
        const backoff = Math.pow(2, attempt + 1) * 1000;
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  Network error for ${url}: ${msg}, retrying in ${backoff}ms...`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      throw err;
    }
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries} retries`);
}

// ---------------------------------------------------------------------------
// PDF download + text extraction via pdftotext
// ---------------------------------------------------------------------------

export async function fetchPdfAsText(
  url: string,
  cacheDir: string,
  cacheKey: string,
): Promise<string | null> {
  const pdfPath = path.join(cacheDir, `${cacheKey}.pdf`);
  const txtPath = path.join(cacheDir, `${cacheKey}.txt`);

  // Use cached text if available
  if (fs.existsSync(txtPath)) {
    return fs.readFileSync(txtPath, 'utf-8');
  }

  await rateLimit();

  try {
    // Download PDF via curl (follows redirects, handles binary)
    execSync(
      `curl -sL -o "${pdfPath}" "${url}"`,
      { timeout: 30_000 },
    );

    if (!fs.existsSync(pdfPath) || fs.statSync(pdfPath).size < 100) {
      console.log(`  PDF download failed or empty for ${url}`);
      return null;
    }

    // Extract text with pdftotext
    try {
      const text = execSync(`pdftotext "${pdfPath}" -`, {
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
      }).toString('utf-8');

      if (text.trim().length > 50) {
        fs.writeFileSync(txtPath, text);
        return text;
      }
    } catch {
      console.log(`  pdftotext extraction failed for ${pdfPath}`);
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  PDF fetch error for ${url}: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Knesset OData API -- always accessible, returns JSON metadata
// ---------------------------------------------------------------------------

export interface KnessetLawMetadata {
  IsraelLawID: number;
  KnessetNum: number | null;
  Name: string; // Hebrew name
  IsBasicLaw: boolean;
  IsFavoriteLaw: boolean;
  PublicationDate: string;
  LatestPublicationDate: string;
  LawValidityID: number;
  LawValidityDesc: string; // Hebrew validity description
  ValidityStartDate: string | null;
  LastUpdatedDate: string;
}

const KNESSET_ODATA_BASE = 'https://knesset.gov.il/Odata/ParliamentInfo.svc';

export async function fetchKnessetODataLaw(
  israelLawId: number,
): Promise<KnessetLawMetadata | null> {
  const url = `${KNESSET_ODATA_BASE}/KNS_IsraelLaw?$filter=IsraelLawID%20eq%20${israelLawId}&$format=json`;
  const result = await fetchWithRateLimit(url);

  if (result.status !== 200) return null;

  try {
    const data = JSON.parse(result.body);
    const values = data.value as KnessetLawMetadata[];
    return values.length > 0 ? values[0] : null;
  } catch {
    return null;
  }
}

export async function searchKnessetODataLaws(
  nameSubstring: string,
): Promise<KnessetLawMetadata[]> {
  const url = `${KNESSET_ODATA_BASE}/KNS_IsraelLaw?$filter=substringof('${encodeURIComponent(nameSubstring)}',Name)&$format=json`;
  const result = await fetchWithRateLimit(url);

  if (result.status !== 200) return [];

  try {
    const data = JSON.parse(result.body);
    return (data.value as KnessetLawMetadata[]) ?? [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Source URL registry -- maps act IDs to known accessible English sources
// ---------------------------------------------------------------------------

export interface SourceConfig {
  /** Primary English text URL (HTML or PDF) */
  url: string;
  /** 'html' | 'pdf' */
  format: 'html' | 'pdf';
  /** Knesset OData IsraelLawID for metadata enrichment */
  knessetLawId?: number;
  /** Description of the source for provenance tracking */
  sourceNote: string;
}

/**
 * Known accessible English translation sources for each act.
 * These are verified to be reachable without Cloudflare blocks.
 */
export const SOURCE_REGISTRY: Record<string, SourceConfig> = {
  'privacy-protection-law-1981': {
    url: 'https://ics.uci.edu/~kobsa/privacy/israel.htm',
    format: 'html',
    knessetLawId: 2000234,
    sourceNote: 'UCI mirror of English translation by Haim Ravia Law Offices',
  },
  'computer-law-1995': {
    url: 'https://www.unodc.org/cld/uploads/res/document/computer-law_html/Israel_Computers_Law_5755_1995.pdf',
    format: 'pdf',
    knessetLawId: 2000357,
    sourceNote: 'UNODC SHERLOC database English translation',
  },
  'basic-law-human-dignity-1992': {
    url: 'https://m.knesset.gov.il/EN/activity/documents/BasicLawsPDF/BasicLawLiberty.pdf',
    format: 'pdf',
    knessetLawId: undefined, // Basic Laws have different numbering
    sourceNote: 'Official Knesset English translation PDF',
  },
};
