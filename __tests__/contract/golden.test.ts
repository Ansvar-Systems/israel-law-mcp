/**
 * Golden contract tests for Israel Law MCP.
 * Validates DB integrity for full official-portal ingestion.
 *
 * Skipped automatically when the database file is absent (e.g. CI without artifacts).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../../data/database.db');
const CENSUS_PATH = path.resolve(__dirname, '../../data/census.json');
const FIXTURE_PATH = path.resolve(__dirname, '../../fixtures/golden-tests.json');

const DB_EXISTS = fs.existsSync(DB_PATH);

interface CensusLaw {
  id: string;
  title: string;
  provisions: number;
}

interface Census {
  schema_version: string;
  jurisdiction: string;
  total_laws: number;
  total_provisions: number;
  laws: CensusLaw[];
}

let db: InstanceType<typeof Database>;
let census: Census;

describe.skipIf(!DB_EXISTS)('Database integrity', () => {
  beforeAll(() => {
    db = new Database(DB_PATH, { readonly: true });
    db.pragma('journal_mode = DELETE');
    census = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf-8')) as Census;
  });

  it('should have correct number of legal documents', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM legal_documents').get() as { cnt: number };
    expect(row.cnt).toBe(census.total_laws);
  });

  it('should have correct total provision count', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM legal_provisions').get() as { cnt: number };
    expect(row.cnt).toBe(census.total_provisions);
  });

  it('should have FTS index populated', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM provisions_fts WHERE provisions_fts MATCH 'privacy OR פרטיות'"
    ).get() as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });

  it('should have db_metadata table populated', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM db_metadata').get() as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });
});

describe.skipIf(!DB_EXISTS)('All key laws are present', () => {
  beforeAll(() => {
    if (!db) {
      db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = DELETE');
    }
  });

  const expectedDocs = [
    'privacy-protection-law-1981',
    'data-security-regulations-2017',
    'computer-law-1995',
    'companies-law-1999',
    'electronic-signature-law-2001',
    'credit-data-law-2002',
    'freedom-of-information-law-1998',
    'communications-law-1982',
    'basic-law-human-dignity-1992',
    'regulation-of-security-1998',
  ];

  for (const docId of expectedDocs) {
    it(`should contain document: ${docId}`, () => {
      const row = db.prepare('SELECT id FROM legal_documents WHERE id = ?').get(docId) as { id: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.id).toBe(docId);
    });
  }
});

describe.skipIf(!DB_EXISTS)('Provision retrieval and search', () => {
  beforeAll(() => {
    if (!db) {
      db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = DELETE');
    }
  });

  it('should retrieve section 1 from Privacy Protection Law 1981', () => {
    const row = db.prepare(
      "SELECT content FROM legal_provisions WHERE document_id = 'privacy-protection-law-1981' AND section = '1'"
    ).get() as { content: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.content.length).toBeGreaterThan(20);
  });

  it('should retrieve section 1 from Computer Law 1995', () => {
    const row = db.prepare(
      "SELECT content FROM legal_provisions WHERE document_id = 'computer-law-1995' AND section = '1'"
    ).get() as { content: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.content.length).toBeGreaterThan(20);
  });

  it('should find results via FTS search for database/מאגר', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM provisions_fts WHERE provisions_fts MATCH 'database OR מאגר'"
    ).get() as { cnt: number };
    expect(row.cnt).toBeGreaterThan(0);
  });
});

describe.skipIf(!DB_EXISTS)('Census consistency', () => {
  beforeAll(() => {
    if (!db) {
      db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = DELETE');
    }
    if (!census) {
      census = JSON.parse(fs.readFileSync(CENSUS_PATH, 'utf-8')) as Census;
    }
  });

  it('census law count matches database document count', () => {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM legal_documents').get() as { cnt: number };
    expect(row.cnt).toBe(census.laws.length);
  });

  it('each census law exists in database', () => {
    for (const law of census.laws) {
      const row = db.prepare('SELECT id FROM legal_documents WHERE id = ?').get(law.id) as { id: string } | undefined;
      expect(row, `Missing law: ${law.id}`).toBeDefined();
    }
  });

  it('provision counts match census per law', () => {
    for (const law of census.laws) {
      const row = db.prepare(
        'SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = ?'
      ).get(law.id) as { cnt: number };
      expect(row.cnt, `Mismatch for ${law.id}`).toBe(law.provisions);
    }
  });
});

describe.skipIf(!DB_EXISTS)('Negative tests', () => {
  beforeAll(() => {
    if (!db) {
      db = new Database(DB_PATH, { readonly: true });
      db.pragma('journal_mode = DELETE');
    }
  });

  it('should return no results for fictional document', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = 'fictional-law-2099'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });

  it('should return no results for invalid section', () => {
    const row = db.prepare(
      "SELECT COUNT(*) as cnt FROM legal_provisions WHERE document_id = 'privacy-protection-law-1981' AND section = '999ZZZ-INVALID'"
    ).get() as { cnt: number };
    expect(row.cnt).toBe(0);
  });
});

describe('Golden fixture file validation', () => {
  const HAS_FIXTURE = fs.existsSync(FIXTURE_PATH);

  it.skipIf(!HAS_FIXTURE)('fixture file is valid', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    expect(fixture.version).toBe('1.0');
    expect(fixture.mcp_name).toBe('Israel Law MCP');
    expect(fixture.tests.length).toBeGreaterThan(0);
  });
});
