/**
 * get_eu_basis -- Get EU legal basis for an Israeli statute.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface GetEUBasisInput {
  document_id: string;
  include_articles?: boolean;
  reference_types?: string[];
}

export interface EUBasisResult {
  eu_document_id: string;
  eu_document_type: string;
  eu_document_title: string | null;
  reference_type: string;
  reference_count: number;
  implementation_status: string | null;
  articles?: string[];
}

export async function getEUBasis(
  db: InstanceType<typeof Database>,
  input: GetEUBasisInput,
): Promise<ToolResponse<EUBasisResult[]>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  // Check if EU reference tables exist
  try {
    db.prepare('SELECT 1 FROM eu_references LIMIT 1').get();
  } catch {
    return {
      results: [],
      _metadata: {
        ...generateResponseMetadata(db),
        ...{ note: 'EU references not available in this database tier' },
      },
    };
  }

  let sql = `
    SELECT
      er.eu_document_id,
      ed.type as eu_document_type,
      COALESCE(ed.title, ed.short_name) as eu_document_title,
      er.reference_type,
      COUNT(*) as reference_count,
      MAX(er.implementation_status) as implementation_status
    FROM eu_references er
    LEFT JOIN eu_documents ed ON ed.id = er.eu_document_id
    WHERE er.document_id = ?
  `;
  const params: string[] = [resolvedId];

  if (input.reference_types && input.reference_types.length > 0) {
    const placeholders = input.reference_types.map(() => '?').join(', ');
    sql += ` AND er.reference_type IN (${placeholders})`;
    params.push(...input.reference_types);
  }

  sql += ' GROUP BY er.eu_document_id, er.reference_type ORDER BY reference_count DESC';

  const rows = db.prepare(sql).all(...params) as EUBasisResult[];

  if (input.include_articles) {
    for (const row of rows) {
      const articles = db.prepare(
        'SELECT DISTINCT eu_article FROM eu_references WHERE document_id = ? AND eu_document_id = ? AND eu_article IS NOT NULL'
      ).all(resolvedId, row.eu_document_id) as { eu_article: string }[];
      row.articles = articles.map(a => a.eu_article);
    }
  }

  return { results: rows, _metadata: generateResponseMetadata(db) };
}
