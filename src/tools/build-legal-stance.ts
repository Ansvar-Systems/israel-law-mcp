/**
 * build_legal_stance -- Build a comprehensive set of citations for a legal question.
 */

import type Database from '@ansvar/mcp-sqlite';
import { buildFtsQueryVariants, sanitizeFtsInput } from '../utils/fts-query.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface BuildLegalStanceInput {
  query: string;
  document_id?: string;
  limit?: number;
}

export interface LegalStanceResult {
  document_id: string;
  document_title: string;
  provision_ref: string;
  section: string;
  title: string | null;
  snippet: string;
  relevance: number;
}

export async function buildLegalStance(
  db: InstanceType<typeof Database>,
  input: BuildLegalStanceInput,
): Promise<ToolResponse<LegalStanceResult[]>> {
  if (!input.query || input.query.trim().length === 0) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const queryVariants = buildFtsQueryVariants(sanitizeFtsInput(input.query));

  for (const ftsQuery of queryVariants) {
    let sql = `
      SELECT
        lp.document_id,
        ld.title as document_title,
        lp.provision_ref,
        lp.section,
        lp.title,
        snippet(provisions_fts, 0, '>>>', '<<<', '...', 48) as snippet,
        bm25(provisions_fts) as relevance
      FROM provisions_fts
      JOIN legal_provisions lp ON lp.id = provisions_fts.rowid
      JOIN legal_documents ld ON ld.id = lp.document_id
      WHERE provisions_fts MATCH ?
    `;
    const params: (string | number)[] = [ftsQuery];

    if (input.document_id) {
      sql += ' AND lp.document_id = ?';
      params.push(input.document_id);
    }

    sql += ' ORDER BY relevance LIMIT ?';
    params.push(limit);

    try {
      const rows = db.prepare(sql).all(...params) as LegalStanceResult[];
      if (rows.length > 0) {
        return { results: rows, _metadata: generateResponseMetadata(db) };
      }
    } catch {
      continue;
    }
  }

  return { results: [], _metadata: generateResponseMetadata(db) };
}
