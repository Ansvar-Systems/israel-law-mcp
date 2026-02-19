/**
 * get_provision_eu_basis -- Get EU legal basis for a specific provision.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface GetProvisionEUBasisInput {
  document_id: string;
  provision_ref: string;
}

export interface ProvisionEUBasisResult {
  eu_document_id: string;
  eu_document_type: string;
  eu_document_title: string | null;
  eu_article: string | null;
  reference_type: string;
  reference_context: string | null;
  full_citation: string | null;
}

export async function getProvisionEUBasis(
  db: InstanceType<typeof Database>,
  input: GetProvisionEUBasisInput,
): Promise<ToolResponse<ProvisionEUBasisResult[]>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

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

  // Find the provision
  const ref = input.provision_ref.trim();
  const provision = db.prepare(
    "SELECT id FROM legal_provisions WHERE document_id = ? AND (provision_ref = ? OR provision_ref = ? OR section = ?)"
  ).get(resolvedId, ref, `sec${ref}`, ref) as { id: number } | undefined;

  if (!provision) {
    return { results: [], _metadata: generateResponseMetadata(db) };
  }

  const rows = db.prepare(`
    SELECT
      er.eu_document_id,
      ed.type as eu_document_type,
      COALESCE(ed.title, ed.short_name) as eu_document_title,
      er.eu_article,
      er.reference_type,
      er.reference_context,
      er.full_citation
    FROM eu_references er
    LEFT JOIN eu_documents ed ON ed.id = er.eu_document_id
    WHERE er.provision_id = ?
    ORDER BY er.reference_type, er.eu_document_id
  `).all(provision.id) as ProvisionEUBasisResult[];

  return { results: rows, _metadata: generateResponseMetadata(db) };
}
