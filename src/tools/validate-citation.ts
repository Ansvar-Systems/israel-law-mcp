/**
 * validate_citation -- Validate an Israeli legal citation against the database.
 *
 * Supports citation formats:
 * - "Section N, [Law Name Year]"
 * - "Section N [Law Name]"
 * - "\u00a7N [Law Name]"
 * - "\u05e1\u05e2\u05d9\u05e3 N" (Hebrew: se'if N)
 */

import type Database from '@ansvar/mcp-sqlite';
import { resolveDocumentId } from '../utils/statute-id.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface ValidateCitationInput {
  citation: string;
}

export interface ValidateCitationResult {
  valid: boolean;
  citation: string;
  normalized?: string;
  document_id?: string;
  document_title?: string;
  provision_ref?: string;
  status?: string;
  warnings: string[];
}

/**
 * Parse an Israeli legal citation.
 * Supports:
 * - "Section N, Law Name Year" / "Section N Law Name"
 * - "\u00a7N Law Name" / "\u00a7 N Law Name"
 * - "\u05e1\u05e2\u05d9\u05e3 N, Law Name" (Hebrew)
 * - "Law Name, Section N"
 * - Just a law name
 */
function parseCitation(citation: string): { documentRef: string; sectionRef?: string } | null {
  const trimmed = citation.trim();

  // "Section N, <law>" or "Section N <law>"
  const sectionFirst = trimmed.match(/^Section\s+(\d+[A-Za-z]*(?:\(\d+\))?)[,;]?\s+(.+)$/i);
  if (sectionFirst) {
    return { documentRef: sectionFirst[2].trim(), sectionRef: sectionFirst[1] };
  }

  // "\u00a7N <law>" or "\u00a7 N <law>"
  const paraFirst = trimmed.match(/^\u00a7\s*(\d+[A-Za-z]*(?:\(\d+\))?)[,;]?\s+(.+)$/);
  if (paraFirst) {
    return { documentRef: paraFirst[2].trim(), sectionRef: paraFirst[1] };
  }

  // "\u05e1\u05e2\u05d9\u05e3 N, <law>" (Hebrew: se'if)
  const hebrewSection = trimmed.match(/^\u05e1\u05e2\u05d9\u05e3\s+(\d+[A-Za-z]*(?:\(\d+\))?)[,;]?\s+(.+)$/);
  if (hebrewSection) {
    return { documentRef: hebrewSection[2].trim(), sectionRef: hebrewSection[1] };
  }

  // "<law>, Section N" or "<law> Section N"
  const sectionLast = trimmed.match(/^(.+?)[,;]?\s*Section\s+(\d+[A-Za-z]*(?:\(\d+\))?)$/i);
  if (sectionLast) {
    return { documentRef: sectionLast[1].trim(), sectionRef: sectionLast[2] };
  }

  // "<law>, \u00a7N" or "<law> \u00a7N"
  const paraLast = trimmed.match(/^(.+?)[,;]?\s*\u00a7\s*(\d+[A-Za-z]*(?:\(\d+\))?)$/);
  if (paraLast) {
    return { documentRef: paraLast[1].trim(), sectionRef: paraLast[2] };
  }

  // Just a document reference
  return { documentRef: trimmed };
}

export async function validateCitationTool(
  db: InstanceType<typeof Database>,
  input: ValidateCitationInput,
): Promise<ToolResponse<ValidateCitationResult>> {
  const warnings: string[] = [];
  const parsed = parseCitation(input.citation);

  if (!parsed) {
    return {
      results: {
        valid: false,
        citation: input.citation,
        warnings: ['Could not parse citation format'],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const docId = resolveDocumentId(db, parsed.documentRef);
  if (!docId) {
    return {
      results: {
        valid: false,
        citation: input.citation,
        warnings: [`Document not found: "${parsed.documentRef}"`],
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  const doc = db.prepare(
    'SELECT id, title, status FROM legal_documents WHERE id = ?'
  ).get(docId) as { id: string; title: string; status: string };

  if (doc.status === 'repealed') {
    warnings.push(`WARNING: This statute has been repealed.`);
  } else if (doc.status === 'amended') {
    warnings.push(`Note: This statute has been amended. Verify you are referencing the current version.`);
  }

  if (parsed.sectionRef) {
    const provision = db.prepare(
      "SELECT provision_ref FROM legal_provisions WHERE document_id = ? AND (provision_ref = ? OR provision_ref = ? OR section = ?)"
    ).get(docId, parsed.sectionRef, `sec${parsed.sectionRef}`, parsed.sectionRef) as { provision_ref: string } | undefined;

    if (!provision) {
      return {
        results: {
          valid: false,
          citation: input.citation,
          document_id: docId,
          document_title: doc.title,
          warnings: [...warnings, `Provision "${parsed.sectionRef}" not found in ${doc.title}`],
        },
        _metadata: generateResponseMetadata(db),
      };
    }

    return {
      results: {
        valid: true,
        citation: input.citation,
        normalized: `Section ${parsed.sectionRef}, ${doc.title}`,
        document_id: docId,
        document_title: doc.title,
        provision_ref: provision.provision_ref,
        status: doc.status,
        warnings,
      },
      _metadata: generateResponseMetadata(db),
    };
  }

  return {
    results: {
      valid: true,
      citation: input.citation,
      normalized: doc.title,
      document_id: docId,
      document_title: doc.title,
      status: doc.status,
      warnings,
    },
    _metadata: generateResponseMetadata(db),
  };
}
