import type { VercelRequest, VercelResponse } from '@vercel/node';
import Database from '@ansvar/mcp-sqlite';
import { existsSync, copyFileSync, rmSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  REPOSITORY_URL,
  SERVER_NAME,
  SERVER_VERSION,
  DB_ENV_VAR,
} from '../src/constants.js';

const SOURCE_DB = process.env[DB_ENV_VAR] || join(process.cwd(), 'data', 'database.db');
const TMP_DB = '/tmp/database.db';
const TMP_DB_META = '/tmp/database.db.meta.json';
const STALENESS_THRESHOLD_DAYS = 30;

function getHealthDb(): InstanceType<typeof Database> | null {
  try {
    if (!existsSync(TMP_DB) && existsSync(SOURCE_DB)) {
      rmSync('/tmp/database.db.lock', { recursive: true, force: true });
      copyFileSync(SOURCE_DB, TMP_DB);
      const stats = statSync(SOURCE_DB);
      writeFileSync(
        TMP_DB_META,
        JSON.stringify({ source_db: SOURCE_DB, source_signature: `${stats.size}:${Math.trunc(stats.mtimeMs)}` }),
        'utf-8',
      );
    }
    if (existsSync(TMP_DB)) {
      return new Database(TMP_DB, { readonly: true });
    }
  } catch {
    // DB not available
  }
  return null;
}

function readMeta(db: InstanceType<typeof Database>, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM db_metadata WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function safeCount(db: InstanceType<typeof Database>, sql: string): number {
  try {
    const row = db.prepare(sql).get() as { count: number } | undefined;
    return row ? Number(row.count) : 0;
  } catch {
    return 0;
  }
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  const url = new URL(req.url ?? '/', `https://${req.headers.host}`);

  if (url.pathname === '/version' || url.searchParams.has('version')) {
    res.status(200).json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      node_version: process.version,
      transport: ['stdio', 'streamable-http'],
      capabilities: ['statutes', 'eu_cross_references'],
      tier: 'free',
      source_schema_version: '1.0',
      repo_url: REPOSITORY_URL,
      report_issue_url: `${REPOSITORY_URL}/issues/new?template=data-error.md`,
    });
    return;
  }

  const db = getHealthDb();
  let dataStatus: 'ok' | 'stale' | 'degraded' = 'degraded';
  let builtAt: string | null = null;
  let daysSinceBuilt: number | null = null;
  let tier: string = 'free';
  let schemaVersion: string = 'unknown';
  let counts: Record<string, number> = {};

  if (db) {
    try {
      builtAt = readMeta(db, 'built_at');
      tier = readMeta(db, 'tier') ?? 'free';
      schemaVersion = readMeta(db, 'schema_version') ?? 'unknown';

      if (builtAt) {
        daysSinceBuilt = Math.floor(
          (Date.now() - new Date(builtAt).getTime()) / (1000 * 60 * 60 * 24),
        );
        dataStatus = daysSinceBuilt > STALENESS_THRESHOLD_DAYS ? 'stale' : 'ok';
      }

      counts = {
        documents: safeCount(db, 'SELECT COUNT(*) as count FROM legal_documents'),
        provisions: safeCount(db, 'SELECT COUNT(*) as count FROM legal_provisions'),
      };
    } finally {
      db.close();
    }
  }

  res.status(200).json({
    status: dataStatus,
    server: SERVER_NAME,
    version: SERVER_VERSION,
    uptime_seconds: Math.floor(process.uptime()),
    data: {
      built_at: builtAt,
      days_since_built: daysSinceBuilt,
      staleness_threshold_days: STALENESS_THRESHOLD_DAYS,
      schema_version: schemaVersion,
      counts,
    },
    capabilities: ['statutes', 'eu_cross_references'],
    tier,
  });
}
