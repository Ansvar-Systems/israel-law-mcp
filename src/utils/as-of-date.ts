/**
 * Date normalization for temporal queries.
 */

/**
 * Normalize an as-of date string to ISO 8601 format.
 * Returns null if the input is not a valid date.
 */
export function normalizeAsOfDate(input?: string): string | null {
  if (!input || input.trim().length === 0) return null;

  const trimmed = input.trim();

  // Already ISO 8601
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    if (!isNaN(date.getTime())) return trimmed;
  }

  // Try parsing as a general date
  const date = new Date(trimmed);
  if (!isNaN(date.getTime())) {
    return date.toISOString().slice(0, 10);
  }

  return null;
}
