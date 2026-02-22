# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-02-22
### Added
- `data/census.json` — full law census (10 laws, 135 provisions, jurisdiction IL)
- Dual transport in `server.json` (stdio + streamable-http via Vercel)
- Census consistency tests validating DB matches census
- `describe.skipIf` guards on all DB-dependent test suites (CI-safe)

### Changed
- Rewrote `__tests__/contract/golden.test.ts` to golden standard pattern
  - DB integrity, key law presence, provision retrieval, FTS search, negative tests
  - All describe blocks skip gracefully when `data/database.db` is absent
- Updated `server.json` to `packages` format with Vercel endpoint

## [1.0.0] - 2026-02-19
### Added
- Initial release of Israel Law MCP
- `search_legislation` tool for full-text search across all Israeli statutes
- `get_provision` tool for retrieving specific articles/sections
- `get_provision_eu_basis` tool for international framework cross-references (GDPR adequacy)
- `validate_citation` tool for legal citation validation
- `check_statute_currency` tool for checking statute amendment status
- `list_laws` tool for browsing available legislation
- Contract tests with 12 golden test cases
- Drift detection with 6 stable provision anchors
- Health and version endpoints
- Vercel deployment (single tier bundled)
- npm package with stdio transport
- MCP Registry publishing

[Unreleased]: https://github.com/Ansvar-Systems/israel-law-mcp/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Ansvar-Systems/israel-law-mcp/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/Ansvar-Systems/israel-law-mcp/releases/tag/v1.0.0
