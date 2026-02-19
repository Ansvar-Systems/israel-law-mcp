# Israel Law MCP

[![npm](https://img.shields.io/npm/v/@ansvar/israel-law-mcp)](https://www.npmjs.com/package/@ansvar/israel-law-mcp)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![CI](https://github.com/Ansvar-Systems/israel-law-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Ansvar-Systems/israel-law-mcp/actions/workflows/ci.yml)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-green)](https://registry.modelcontextprotocol.io/)
[![OpenSSF Scorecard](https://img.shields.io/ossf-scorecard/github.com/Ansvar-Systems/israel-law-mcp)](https://securityscorecards.dev/viewer/?uri=github.com/Ansvar-Systems/israel-law-mcp)

A Model Context Protocol (MCP) server providing comprehensive access to Israeli legislation, including the Privacy Protection Law, Protection of Privacy Regulations (Data Security), Computer Law, Companies Law, Electronic Signature Law, and Credit Data Law with full-text search.

## Deployment Tier

**SMALL** -- Single tier, bundled SQLite database shipped with the npm package.

**Estimated database size:** ~60-120 MB (full corpus of Israeli federal legislation with English translations)

## Key Legislation Covered

| Law | Year | Significance |
|-----|------|-------------|
| **Privacy Protection Law** | 1981 (amended) | Comprehensive privacy law; predates GDPR; Israel has EU adequacy decision; database registration regime |
| **Protection of Privacy Regulations (Data Security)** | 2017 | Specific technical and organisational security requirements for database owners; four security levels |
| **Computer Law** | 1995 | Criminalises unauthorised computer access, interference, and computer viruses |
| **Companies Law** | 1999 | Corporate governance, registration, directors' duties, and corporate obligations |
| **Electronic Signature Law** | 2001 | Legal recognition of electronic signatures and certification authorities |
| **Credit Data Law** | 2002 | Regulation of credit data collection, processing, and sharing |
| **Basic Law: Human Dignity and Liberty** | 1992 | Quasi-constitutional protection of human dignity and liberty including privacy |

## Regulatory Context

- **Data Protection Supervisory Authority:** Privacy Protection Authority (PPA), operating under the Ministry of Justice
- **Israel has an EU adequacy decision** under the Data Protection Directive, maintained under GDPR review, recognising Israel's data protection framework as providing adequate safeguards for data transfers from the EU
- **The Privacy Protection Law (1981)** established one of the earliest comprehensive data protection frameworks globally; it is being modernised to align more closely with GDPR
- **Protection of Privacy Regulations (Data Security) 2017** impose specific technical requirements at four security levels based on database sensitivity and size
- Israel is a **major global cybersecurity hub** (Unit 8200, extensive startup ecosystem), making its legal framework highly relevant to cybersecurity clients
- Israel uses a mixed legal system combining elements of common law, civil law, and religious law
- Hebrew is the legally binding language; English translations are available for major laws but are unofficial
- The Knesset (parliament) database and Nevo commercial database are the primary legal information sources

## Data Sources

| Source | Authority | Method | Update Frequency | License | Coverage |
|--------|-----------|--------|-----------------|---------|----------|
| [Knesset Legislation Database](https://main.knesset.gov.il/Activity/Legislation) | The Knesset | HTML Scrape | Weekly | Government Open Data | All primary legislation, Basic Laws, bills |
| [Nevo Legal Database](https://www.nevo.co.il) | Nevo (commercial) | HTML Scrape | Daily | Commercial (public law content) | Comprehensive legislation, regulations, court decisions |
| [Israeli Law Resource Center](https://www.gov.il/en/departments/legalinfo) | Government of Israel | HTML Scrape | Monthly | Government Publication | English translations of major laws |

> Full provenance metadata: [`sources.yml`](./sources.yml)

## Installation

```bash
npm install -g @ansvar/israel-law-mcp
```

## Usage

### As stdio MCP server

```bash
israel-law-mcp
```

### In Claude Desktop / MCP client configuration

```json
{
  "mcpServers": {
    "israel-law": {
      "command": "npx",
      "args": ["-y", "@ansvar/israel-law-mcp"]
    }
  }
}
```

## Available Tools

| Tool | Description |
|------|-------------|
| `get_provision` | Retrieve a specific section/article from an Israeli law |
| `search_legislation` | Full-text search across all Israeli legislation |
| `get_provision_eu_basis` | Cross-reference lookup for international framework relationships (GDPR adequacy, etc.) |

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Run contract tests
npm run test:contract

# Run all validation
npm run validate

# Build database from sources
npm run build:db

# Start server
npm start
```

## Contract Tests

This MCP includes 12 golden contract tests covering:
- 3 article retrieval tests (Privacy Protection Law, Companies Law)
- 3 search tests (privacy, data security, computer)
- 2 citation roundtrip tests (official knesset.gov.il/nevo.co.il URL patterns)
- 2 cross-reference tests (GDPR adequacy, data security standards)
- 2 negative tests (non-existent law, malformed section)

Run with: `npm run test:contract`

## EU Adequacy Decision

Israel is one of the few non-EU countries with an EU adequacy decision for data protection. This means:
- Personal data can flow freely from the EU/EEA to Israel without additional safeguards
- The Privacy Protection Law and its regulations are considered to provide an adequate level of data protection
- The adequacy decision is subject to periodic review by the European Commission

This makes Israel Law MCP particularly relevant for organisations operating across EU-Israel data flows.

## Security

See [SECURITY.md](./SECURITY.md) for vulnerability disclosure policy.

Report data errors: [Open an issue](https://github.com/Ansvar-Systems/israel-law-mcp/issues/new?template=data-error.md)

## License

Apache-2.0 -- see [LICENSE](./LICENSE)

---

Built by [Ansvar Systems](https://ansvar.eu) -- Cybersecurity compliance through AI-powered analysis.
