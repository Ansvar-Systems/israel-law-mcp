/**
 * check_currency -- Check whether an Israeli statute is currently in force.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface CheckCurrencyInput {
  document_id: string;
  provision_ref?: string;
  as_of_date?: string;
}

export interface CheckCurrencyResult {
  document_id: string;
  title: string;
  status: string;
  issued_date: string | null;
  in_force_date: string | null;
  warnings: string[];
}

export async function checkCurrency(
  db: InstanceType<typeof Database>,
  input: CheckCurrencyInput,
): Promise<ToolResponse<CheckCurrencyResult>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return {
      results: {
        document_id: input.document_id,
        title: 'Unknown',
        status: 'not_found',
        issued_date: null,
        in_force_date: null,
        warnings: [`Document not found: "${input.document_id}"`],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const doc = db.prepare(
    'SELECT id, title, status, issued_date, in_force_date FROM legal_documents WHERE id = ?'
  ).get(resolvedId) as {
    id: string;
    title: string;
    status: string;
    issued_date: string | null;
    in_force_date: string | null;
  };

  const warnings: string[] = [];
  if (doc.status === 'repealed') {
    warnings.push('This statute has been repealed and is no longer in force.');
  } else if (doc.status === 'not_yet_in_force') {
    warnings.push('This statute has not yet entered into force.');
  }

  return {
    results: {
      document_id: doc.id,
      title: doc.title,
      status: doc.status,
      issued_date: doc.issued_date,
      in_force_date: doc.in_force_date,
      warnings,
    },
    _metadata: generateResponseMetadata(db),
  };
}
