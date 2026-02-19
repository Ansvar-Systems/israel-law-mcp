/**
 * search_eu_implementations -- Search EU directives/regulations with Israeli aligning legislation.
 */

import type Database from '@ansvar/mcp-sqlite';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SearchEUImplementationsInput {
  query?: string;
  type?: 'directive' | 'regulation';
  year_from?: number;
  year_to?: number;
  has_israeli_implementation?: boolean;
  limit?: number;
}

export interface EUImplementationSearchResult {
  eu_document_id: string;
  type: string;
  year: number;
  number: number;
  title: string | null;
  short_name: string | null;
  israeli_statute_count: number;
}

export async function searchEUImplementations(
  db: InstanceType<typeof Database>,
  input: SearchEUImplementationsInput,
): Promise<ToolResponse<EUImplementationSearchResult[]>> {
  try {
    db.prepare('SELECT 1 FROM eu_documents LIMIT 1').get();
  } catch {
    return {
      results: [],
      _metadata: {
        ...generateResponseMetadata(db),
        ...{ note: 'EU documents not available in this database tier' },
      },
    };
  }

  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  let sql = `
    SELECT
      ed.id as eu_document_id,
      ed.type,
      ed.year,
      ed.number,
      ed.title,
      ed.short_name,
      COUNT(DISTINCT er.document_id) as israeli_statute_count
    FROM eu_documents ed
    LEFT JOIN eu_references er ON er.eu_document_id = ed.id
    WHERE 1=1
  `;
  const params: (string | number)[] = [];

  if (input.query) {
    sql += ' AND (ed.title LIKE ? OR ed.short_name LIKE ? OR ed.description LIKE ?)';
    params.push(`%${input.query}%`, `%${input.query}%`, `%${input.query}%`);
  }

  if (input.type) {
    sql += ' AND ed.type = ?';
    params.push(input.type);
  }

  if (input.year_from) {
    sql += ' AND ed.year >= ?';
    params.push(input.year_from);
  }

  if (input.year_to) {
    sql += ' AND ed.year <= ?';
    params.push(input.year_to);
  }

  sql += ' GROUP BY ed.id';

  if (input.has_israeli_implementation) {
    sql += ' HAVING israeli_statute_count > 0';
  }

  sql += ' ORDER BY ed.year DESC, ed.number DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as EUImplementationSearchResult[];
  return { results: rows, _metadata: generateResponseMetadata(db) };
}
