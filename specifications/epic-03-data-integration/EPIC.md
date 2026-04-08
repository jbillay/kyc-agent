# EPIC: Data Integration Layer

> GitHub Issue: [#13](https://github.com/jbillay/kyc-agent/issues/13)
> Milestone: Phase 1 — Foundation
> Labels: `epic`, `data-integration`

## Overview

Abstracts all external data sources behind unified interfaces. Every data source — corporate registries, sanctions lists, news APIs — is a swappable provider. All responses are cached and versioned in PostgreSQL so that every KYC decision can prove exactly what data was available at decision time.

This layer sits between the agents (Layer 3) and the outside world. No agent calls an external API directly — all data access goes through provider interfaces with automatic caching.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #14 | Data source provider interface and registry abstraction | M | Critical | `provider-interface/` |
| #15 | Companies House API integration | L | Critical | `companies-house/` |
| #16 | Data source response caching and versioning | M | High | `data-caching/` |
| #17 | OFAC SDN sanctions list ingestion and search | L | Critical | `ofac-sdn/` |
| #18 | UK HMT sanctions list ingestion and search | M | Critical | `uk-hmt/` |
| #19 | Fuzzy name matching engine for screening | M | Critical | `fuzzy-matching/` |

## Dependency Map

```
#14 Provider Interface ─────────────────────────────────┐
    (defines RegistryProvider + ScreeningProvider)       │
    │                                                    │
    ├──► #15 Companies House (implements RegistryProvider)│
    │                                                    │
    ├──► #17 OFAC SDN  ◄─── #19 Fuzzy Matching          │
    │    (implements      (shared matching engine)       │
    │     ScreeningProvider)                              │
    │                                                    │
    ├──► #18 UK HMT   ◄─── #19 Fuzzy Matching           │
    │    (implements ScreeningProvider)                   │
    │                                                    │
    └──► #16 Data Caching                                │
         (wraps all providers transparently)             │

Recommended implementation order:
  1. #14 Provider Interface (defines all contracts)
  2. #16 Data Caching      (needed by all providers)
  3. #19 Fuzzy Matching    (needed by screening providers)
  4. #15 Companies House   (parallel with #17/#18)
  5. #17 OFAC SDN          (parallel with #15/#18)
  6. #18 UK HMT            (parallel with #15/#17)
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 4.1 — Purpose
- Section 4.2.1 — Corporate Registry Providers (RegistryProvider interface, type definitions)
- Section 4.2.2 — Screening Providers (ScreeningProvider interface, screening sources table)
- Section 4.2.3 — Data Caching & Versioning (cache table schema)

## File Layout

```
backend/src/data-sources/
├── types.js                    # Shared types
├── cache.js                    # Cache service wrapping all providers
├── registry/
│   ├── types.js                # RegistryProvider, EntityDetails, Officer, etc.
│   ├── companies-house.js      # Companies House API implementation
│   └── sec-edgar.js            # SEC EDGAR (stub for Phase 1)
├── screening/
│   ├── types.js                # ScreeningProvider, ScreeningQuery, ScreeningHit
│   ├── ofac.js                 # OFAC SDN provider
│   ├── uk-hmt.js               # UK HMT provider
│   ├── un-consolidated.js      # UN (stub for Phase 1)
│   └── fuzzy-matcher.js        # Fuzzy name matching engine
└── media/
    ├── types.js                # Media provider types (Phase 2)
    └── news-search.js          # News search (Phase 2)
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Local screening lists | Download and cache in PostgreSQL | Instant screening (no API latency), offline capable, auditable |
| Cache in PostgreSQL | `data_source_cache` table | Queryable, links to cases, no additional infrastructure |
| TTL-based caching | Per-provider configurable TTL | Companies House data is stable (24h), sanctions lists change daily (1h) |
| Expired entries retained | Never deleted | Audit requirement — prove what data was available at decision time |
| Fuzzy matching | Multi-algorithm weighted scoring | Single algorithm misses edge cases; weighted combination catches more |

## Definition of Done

- [ ] `RegistryProvider` and `ScreeningProvider` interfaces defined with full JSDoc types
- [ ] Companies House provider searches, retrieves details, officers, and PSC data
- [ ] All external API responses cached with SHA-256 hash keys and configurable TTL
- [ ] OFAC SDN list ingested from XML, stored locally, searchable with fuzzy matching
- [ ] UK HMT list ingested from CSV, stored locally, searchable with fuzzy matching
- [ ] Fuzzy matcher scores names 0-100 using Levenshtein + Jaro-Winkler + phonetic algorithms
- [ ] Cache entries link to `case_id` for audit traceability
- [ ] Integration tests with real Companies House API and known SDN entries
