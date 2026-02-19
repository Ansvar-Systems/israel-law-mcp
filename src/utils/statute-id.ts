/**
 * Statute ID resolution for Israel Law MCP.
 *
 * Resolves fuzzy document references (titles, law names) to database document IDs.
 */

import type Database from '@ansvar/mcp-sqlite';

/**
 * Resolve a document identifier to a database document ID.
 * Supports:
 * - Direct ID match (e.g., "privacy-protection-law-1981")
 * - Law name + year match (e.g., "Privacy Protection Law 1981")
 * - Title substring match (e.g., "Privacy Protection", "Computer Law")
 * - Short name match (e.g., "PPL", "Computer Law")
 */
export function resolveDocumentId(
  db: InstanceType<typeof Database>,
  input: string,
): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Direct ID match
  const directMatch = db.prepare(
    'SELECT id FROM legal_documents WHERE id = ?'
  ).get(trimmed) as { id: string } | undefined;
  if (directMatch) return directMatch.id;

  // Short name exact match (case-insensitive)
  const shortNameMatch = db.prepare(
    "SELECT id FROM legal_documents WHERE LOWER(short_name) = LOWER(?) LIMIT 1"
  ).get(trimmed) as { id: string } | undefined;
  if (shortNameMatch) return shortNameMatch.id;

  // Title/short_name fuzzy match
  const titleResult = db.prepare(
    "SELECT id FROM legal_documents WHERE title LIKE ? OR short_name LIKE ? OR title_en LIKE ? LIMIT 1"
  ).get(`%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`) as { id: string } | undefined;
  if (titleResult) return titleResult.id;

  // Case-insensitive fallback
  const lowerResult = db.prepare(
    "SELECT id FROM legal_documents WHERE LOWER(title) LIKE LOWER(?) OR LOWER(short_name) LIKE LOWER(?) OR LOWER(title_en) LIKE LOWER(?) LIMIT 1"
  ).get(`%${trimmed}%`, `%${trimmed}%`, `%${trimmed}%`) as { id: string } | undefined;
  if (lowerResult) return lowerResult.id;

  return null;
}
