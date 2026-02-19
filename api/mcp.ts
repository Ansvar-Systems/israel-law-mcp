import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Database from '@ansvar/mcp-sqlite';
import { join } from 'path';
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';

import { registerTools } from '../src/tools/registry.js';
import {
  DB_ENV_VAR,
  SERVER_NAME,
  SERVER_VERSION,
} from '../src/constants.js';
import type { AboutContext } from '../src/tools/registry.js';

const SOURCE_DB = process.env[DB_ENV_VAR]
  || join(process.cwd(), 'data', 'database.db');
const TMP_DB = '/tmp/database.db';
const TMP_DB_LOCK = '/tmp/database.db.lock';
const TMP_DB_SHM = '/tmp/database.db-shm';
const TMP_DB_WAL = '/tmp/database.db-wal';
const TMP_DB_META = '/tmp/database.db.meta.json';

let db: InstanceType<typeof Database> | null = null;

interface TmpDbMeta {
  source_db: string;
  source_signature: string;
}

function computeSourceSignature(): string {
  const stats = statSync(SOURCE_DB);
  return `${stats.size}:${Math.trunc(stats.mtimeMs)}`;
}

function readTmpMeta(): TmpDbMeta | null {
  if (!existsSync(TMP_DB_META)) return null;
  try {
    const parsed = JSON.parse(readFileSync(TMP_DB_META, 'utf-8')) as Partial<TmpDbMeta>;
    if (parsed.source_db && parsed.source_signature) {
      return { source_db: parsed.source_db, source_signature: parsed.source_signature };
    }
  } catch {
    // Ignore corrupted metadata
  }
  return null;
}

function clearTmpDbArtifacts() {
  rmSync(TMP_DB_LOCK, { recursive: true, force: true });
  rmSync(TMP_DB_SHM, { force: true });
  rmSync(TMP_DB_WAL, { force: true });
  rmSync(TMP_DB, { force: true });
  rmSync(TMP_DB_META, { force: true });
}

function ensureTempDbIsFresh() {
  const sourceSignature = computeSourceSignature();
  const meta = readTmpMeta();
  const shouldRefresh =
    !existsSync(TMP_DB) || !meta || meta.source_db !== SOURCE_DB || meta.source_signature !== sourceSignature;

  if (shouldRefresh) {
    clearTmpDbArtifacts();
    copyFileSync(SOURCE_DB, TMP_DB);
    writeFileSync(TMP_DB_META, JSON.stringify({ source_db: SOURCE_DB, source_signature: sourceSignature }), 'utf-8');
    return;
  }

  rmSync(TMP_DB_LOCK, { recursive: true, force: true });
}

function computeAboutContext(): AboutContext {
  let fingerprint = 'unknown';
  let dbBuilt = 'unknown';

  try {
    const buf = readFileSync(SOURCE_DB);
    fingerprint = createHash('sha256').update(buf).digest('hex').slice(0, 12);
  } catch { /* ignore */ }

  try {
    const database = getDatabase();
    const row = database.prepare("SELECT value FROM db_metadata WHERE key = 'built_at'").get() as { value: string } | undefined;
    if (row?.value) dbBuilt = row.value;
  } catch { /* ignore */ }

  return { version: SERVER_VERSION, fingerprint, dbBuilt };
}

function getDatabase(): InstanceType<typeof Database> {
  if (!db) {
    ensureTempDbIsFresh();
    db = new Database(TMP_DB, { readonly: true });
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method === 'GET') {
    res.status(200).json({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      protocol: 'mcp-streamable-http',
    });
    return;
  }

  try {
    if (!existsSync(SOURCE_DB)) {
      res.status(500).json({ error: `Database not found at ${SOURCE_DB}` });
      return;
    }

    const database = getDatabase();
    const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
    registerTools(server, database, computeAboutContext());

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('MCP handler error:', message);
    if (!res.headersSent) {
      res.status(500).json({ error: message });
    }
  }
}
