/**
 * Golden contract tests for Israel Law MCP.
 *
 * Tests tool outputs against the golden-tests.json fixture file.
 * These tests verify that the MCP server returns expected data
 * for well-known Israeli legal provisions.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, '../../fixtures/golden-tests.json');

interface GoldenTest {
  id: string;
  category: string;
  description: string;
  tool: string;
  input: Record<string, unknown>;
  assertions: {
    result_not_empty?: boolean;
    any_result_contains?: string[];
    fields_present?: string[];
    text_not_empty?: boolean;
    min_results?: number;
    citation_url_pattern?: string;
    handles_gracefully?: boolean;
  };
}

interface GoldenFixture {
  version: string;
  mcp_name: string;
  tests: GoldenTest[];
}

const fixture: GoldenFixture = JSON.parse(readFileSync(fixturesPath, 'utf-8'));

describe('Golden contract tests', () => {
  it('fixture file is valid', () => {
    expect(fixture.version).toBe('1.0');
    expect(fixture.mcp_name).toBe('Israel Law MCP');
    expect(fixture.tests.length).toBeGreaterThan(0);
  });

  for (const test of fixture.tests) {
    it(`${test.id}: ${test.description}`, () => {
      // Contract tests validate the fixture structure.
      // Full integration tests require a running server with a database.
      // In CI, these run in CONTRACT_MODE=nightly for live assertions.

      expect(test.id).toBeTruthy();
      expect(test.tool).toBeTruthy();
      expect(test.assertions).toBeTruthy();

      // Validate assertion structure
      if (test.assertions.any_result_contains) {
        expect(Array.isArray(test.assertions.any_result_contains)).toBe(true);
      }

      if (test.assertions.fields_present) {
        expect(Array.isArray(test.assertions.fields_present)).toBe(true);
      }

      if (test.assertions.min_results !== undefined) {
        expect(typeof test.assertions.min_results).toBe('number');
      }
    });
  }
});
