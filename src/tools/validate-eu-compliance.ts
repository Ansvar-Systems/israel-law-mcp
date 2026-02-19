/**
 * validate_eu_compliance -- Check EU alignment status for an Israeli statute.
 *
 * Israel has an EU adequacy decision for data protection, meaning the European
 * Commission recognizes Israel's data protection framework as providing adequate
 * safeguards. This tool checks alignment status for Israeli statutes.
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface ValidateEUComplianceInput {
  document_id: string;
  provision_ref?: string;
  eu_document_id?: string;
}

export interface EUComplianceResult {
  document_id: string;
  document_title: string;
  compliance_status: 'compliant' | 'partial' | 'unclear' | 'not_applicable';
  eu_references_found: number;
  warnings: string[];
  recommendations: string[];
}

export async function validateEUCompliance(
  db: InstanceType<typeof Database>,
  input: ValidateEUComplianceInput,
): Promise<ToolResponse<EUComplianceResult>> {
  const resolvedId = resolveDocumentId(db, input.document_id);
  if (!resolvedId) {
    return {
      results: {
        document_id: input.document_id,
        document_title: 'Unknown',
        compliance_status: 'not_applicable',
        eu_references_found: 0,
        warnings: [`Document not found: "${input.document_id}"`],
        recommendations: [],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const doc = db.prepare(
    'SELECT id, title, status FROM legal_documents WHERE id = ?'
  ).get(resolvedId) as { id: string; title: string; status: string };

  const warnings: string[] = [];
  const recommendations: string[] = [];

  // Check if EU reference tables exist
  let euRefCount = 0;
  try {
    let sql = 'SELECT COUNT(*) as count FROM eu_references WHERE document_id = ?';
    const params: string[] = [resolvedId];

    if (input.eu_document_id) {
      sql += ' AND eu_document_id = ?';
      params.push(input.eu_document_id);
    }

    const row = db.prepare(sql).get(...params) as { count: number };
    euRefCount = row.count;
  } catch {
    return {
      results: {
        document_id: resolvedId,
        document_title: doc.title,
        compliance_status: 'not_applicable',
        eu_references_found: 0,
        warnings: ['EU references not available in this database tier'],
        recommendations: [],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  if (euRefCount === 0) {
    return {
      results: {
        document_id: resolvedId,
        document_title: doc.title,
        compliance_status: 'not_applicable',
        eu_references_found: 0,
        warnings: [],
        recommendations: ['No EU cross-references found for this statute. This may be a purely domestic law.'],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  if (doc.status === 'repealed') {
    warnings.push('This statute has been repealed.');
    recommendations.push('Check for replacement legislation.');
  }

  // Check implementation status
  const statuses = db.prepare(
    'SELECT implementation_status, COUNT(*) as count FROM eu_references WHERE document_id = ? GROUP BY implementation_status'
  ).all(resolvedId) as { implementation_status: string | null; count: number }[];

  const statusMap = new Map(statuses.map(s => [s.implementation_status, s.count]));
  const completeCount = statusMap.get('complete') ?? 0;
  const partialCount = statusMap.get('partial') ?? 0;
  const unknownCount = statusMap.get('unknown') ?? 0;

  let compliance_status: 'compliant' | 'partial' | 'unclear' | 'not_applicable';
  if (completeCount > 0 && partialCount === 0 && unknownCount === 0) {
    compliance_status = 'compliant';
  } else if (partialCount > 0) {
    compliance_status = 'partial';
    warnings.push(`${partialCount} EU reference(s) have partial implementation status.`);
  } else {
    compliance_status = 'unclear';
    if (unknownCount > 0) {
      recommendations.push(`${unknownCount} EU reference(s) have unknown implementation status. Manual review recommended.`);
    }
  }

  return {
    results: {
      document_id: resolvedId,
      document_title: doc.title,
      compliance_status,
      eu_references_found: euRefCount,
      warnings,
      recommendations,
    },
    _metadata: generateResponseMetadata(db),
  };
}
