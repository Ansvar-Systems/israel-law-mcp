/**
 * Response metadata utilities for Israel Law MCP.
 */

import type Database from '@ansvar/mcp-sqlite';

export interface ResponseMetadata {
  data_source: string;
  jurisdiction: string;
  disclaimer: string;
  freshness?: string;
}

export interface ToolResponse<T> {
  results: T;
  _metadata: ResponseMetadata;
}

export function generateResponseMetadata(
  db: InstanceType<typeof Database>,
): ResponseMetadata {
  let freshness: string | undefined;
  try {
    const row = db.prepare(
      "SELECT value FROM db_metadata WHERE key = 'built_at'"
    ).get() as { value: string } | undefined;
    if (row) freshness = row.value;
  } catch {
    // Ignore
  }

  return {
    data_source: 'Knesset Legislation Database (knesset.gov.il) + gov.il English translations',
    jurisdiction: 'IL',
    disclaimer:
      'This data is sourced from the Knesset Legislation Database and Israeli government publications. ' +
      'Hebrew is the legally authoritative language. English translations are unofficial. ' +
      'Always verify with the official Knesset or Nevo portals.',
    freshness,
  };
}
