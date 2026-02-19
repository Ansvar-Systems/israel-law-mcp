/**
 * list_sources -- Return provenance metadata for all data sources.
 */

import type Database from '@ansvar/mcp-sqlite';
import { readDbMetadata } from '../capabilities.js';
import { generateResponseMetadata, type ToolResponse } from '../utils/metadata.js';

export interface SourceInfo {
  name: string;
  authority: string;
  url: string;
  license: string;
  coverage: string;
  languages: string[];
}

export interface ListSourcesResult {
  sources: SourceInfo[];
  database: {
    tier: string;
    schema_version: string;
    built_at?: string;
    document_count: number;
    provision_count: number;
  };
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

export async function listSources(
  db: InstanceType<typeof Database>,
): Promise<ToolResponse<ListSourcesResult>> {
  const meta = readDbMetadata(db);

  return {
    results: {
      sources: [
        {
          name: 'Knesset Legislation Database',
          authority: 'The Knesset (Israeli Parliament)',
          url: 'https://main.knesset.gov.il/Activity/Legislation',
          license: 'Government Open Data',
          coverage:
            'All Israeli primary legislation (Chukkim), Basic Laws (Chukei Yesod), ' +
            'and selected regulatory frameworks published in Sefer HaChukkim (Book of Laws)',
          languages: ['he', 'en'],
        },
        {
          name: 'Israeli Government Legal Information',
          authority: 'Government of Israel',
          url: 'https://www.gov.il/en/departments/legalinfo',
          license: 'Government Publication',
          coverage:
            'English translations of major Israeli laws including Basic Laws, Privacy Protection Law, ' +
            'Companies Law, and key regulatory frameworks',
          languages: ['en'],
        },
      ],
      database: {
        tier: meta.tier,
        schema_version: meta.schema_version,
        built_at: meta.built_at,
        document_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
        provision_count: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
      },
    },
    _metadata: generateResponseMetadata(db),
  };
}
