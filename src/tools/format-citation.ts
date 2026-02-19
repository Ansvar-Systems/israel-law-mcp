/**
 * format_citation -- Format an Israeli legal citation per standard conventions.
 *
 * Formats:
 * - "full": "Section N, [Law Name Year]"
 * - "short": "Section N, [Law Name]"
 * - "pinpoint": "\u00a7N"
 */

import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';
import type Database from '@ansvar/mcp-sqlite';

export interface FormatCitationInput {
  citation: string;
  format?: 'full' | 'short' | 'pinpoint';
}

export interface FormatCitationResult {
  original: string;
  formatted: string;
  format: string;
}

export async function formatCitationTool(
  input: FormatCitationInput,
): Promise<FormatCitationResult> {
  const format = input.format ?? 'full';
  const trimmed = input.citation.trim();

  // Parse "Section N, <law>" or "Section N <law>"
  const sectionFirst = trimmed.match(/^Section\s+(\d+[A-Za-z]*(?:\(\d+\))?)[,;]?\s+(.+)$/i);
  // Parse "<law>, Section N" or "<law> Section N"
  const sectionLast = trimmed.match(/^(.+?)[,;]?\s*Section\s+(\d+[A-Za-z]*(?:\(\d+\))?)$/i);
  // Parse "\u00a7N <law>"
  const paraFirst = trimmed.match(/^\u00a7\s*(\d+[A-Za-z]*(?:\(\d+\))?)[,;]?\s+(.+)$/);

  const section = sectionFirst?.[1] ?? sectionLast?.[2] ?? paraFirst?.[1];
  const law = sectionFirst?.[2] ?? sectionLast?.[1] ?? paraFirst?.[2] ?? trimmed;

  let formatted: string;
  switch (format) {
    case 'short':
      formatted = section ? `Section ${section}, ${law.split('(')[0].trim()}` : law;
      break;
    case 'pinpoint':
      formatted = section ? `\u00a7${section}` : law;
      break;
    case 'full':
    default:
      formatted = section ? `Section ${section}, ${law}` : law;
      break;
  }

  return { original: input.citation, formatted, format };
}
