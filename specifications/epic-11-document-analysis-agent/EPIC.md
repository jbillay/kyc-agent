# EPIC: Document Analysis Agent

> GitHub Issue: [#52](https://github.com/jbillay/kyc-agent/issues/52)
> Milestone: Phase 2 — Intelligence
> Labels: `epic`, `agent`

## Overview

The Document Analysis Agent analyzes uploaded KYC documents, extracts structured data, and cross-references it against registry data from the Entity Resolution Agent. It handles the full document lifecycle: classification (identifying the document type), data extraction (pulling structured fields from unstructured content), cross-referencing against the entity profile, authenticity validation, and report generation. The agent produces decision fragments that feed into the Risk Assessment Agent's evaluation.

Documents are stored in MinIO and tracked in the `documents` PostgreSQL table. The agent is triggered when a document is uploaded to a case via the API. The frontend provides a Documents tab in the case detail view with drag-and-drop upload, analysis status tracking, and a side-by-side comparison view for extracted vs. registry data.

## Scope

| # | Story | Size | Priority | Directory |
|---|-------|------|----------|-----------|
| #53 | Document classification and data extraction | L | High | `document-classification/` |
| #54 | Registry cross-referencing and discrepancy detection | M | High | `registry-cross-referencing/` |
| #55 | Document upload and analysis trigger in frontend | M | High | `document-upload-frontend/` |

## Dependency Map

```
#53 Document Classification & Extraction ──────────┐
    (classify document type via LLM,                │
     extract structured data via LLM,               │
     PDF text extraction, image handling)            │
    │                                                │
    ▼                                                │
#54 Registry Cross-Referencing & Discrepancy         │
    (compare extracted data vs EntityProfile,        │
     validate document authenticity,                 │
     generate structured document report)            │
    │                                                │
    ▼                                                │
#55 Document Upload Frontend                         │
    (Documents tab, drag-and-drop upload,            │
     analysis status, extracted data display,        │
     side-by-side comparison view)                   │

Recommended implementation order:
  1. #53 Classification + extraction (establishes agent class + first 2 steps)
  2. #54 Cross-referencing + report (steps 3-5, depends on extraction output)
  3. #55 Frontend (depends on API and data shape from agent)
```

## External Dependencies

```
Agent Framework (#20):
  ├── #21 BaseAgent          ← DocumentAnalysisAgent extends BaseAgent
  ├── #22 Decision Fragments ← document_verified, document_discrepancy
  └── #25 Event Store        ← step progress events

LLM Abstraction (#7):
  ├── #8 LLM Service         ← classification (classification task type)
  └── #8 LLM Service         ← extraction (extraction task type)

Entity Resolution (#26):
  └── #27-#28 EntityProfile   ← cross-reference target

Infrastructure (#1):
  ├── #6 MinIO Storage        ← document file retrieval
  └── #3 Database             ← documents table

Case Management API (#33):
  └── #34 Cases CRUD          ← POST /api/v1/cases/:id/documents endpoint

Frontend (#38):
  └── #41 Case Detail View    ← Documents tab mounts in case detail
```

## Architecture Reference

See `kyc-agent-architecture.md`:
- Section 5.4.4 — Document Analysis Agent (5-step pipeline)
- Section 6.3 — Document Storage (MinIO + DocumentRecord schema)
- Section 7.1 — Cases API (`POST /api/v1/cases/:id/documents`)
- Database: `documents` table schema

## File Layout

```
backend/src/agents/document-analysis/
├── index.js                # DocumentAnalysisAgent class
├── document-classifier.js  # LLM-based document classification
├── data-extractor.js       # LLM-based structured data extraction
├── registry-comparator.js  # Cross-reference extracted data vs EntityProfile
├── authenticity-validator.js # Document authenticity checks
├── report-generator.js     # Structured report generation
├── pdf-extractor.js        # PDF text extraction (pdf-parse)
└── prompts.js              # LLM prompt templates

frontend/src/components/documents/
├── DocumentsTab.vue        # Documents tab container
├── DocumentUpload.vue      # Drag-and-drop upload component
├── DocumentList.vue        # Document list with status indicators
├── DocumentDetail.vue      # Extracted data + cross-reference results
└── DataComparison.vue      # Side-by-side extracted vs registry data
```

## Key Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| PDF text extraction | `pdf-parse` npm package | Lightweight, well-maintained, no external dependencies |
| Image documents | LLM vision (if supported) or skip | No separate OCR dependency; graceful degradation |
| Document classification | LLM classification task | Document types vary; rule-based classification is brittle |
| Data extraction | LLM extraction task | Unstructured documents; LLM handles varied formats |
| Address comparison | Fuzzy matching | Formatting differences are common across sources |
| Name comparison | Case-insensitive + abbreviation handling | "Ltd" vs "Limited", case differences |
| Discrepancy severity | Three levels: critical/warning/info | Registration number mismatch vs address formatting |
| Analysis trigger | Automatic on upload | Reduces manual steps; analyst sees results when ready |

## Agent Steps

| # | Step | LLM Task | Data Sources | Decision Fragments |
|---|------|----------|-------------|-------------------|
| 1 | `classify_document` | classification | Document content (MinIO) | — (intermediate) |
| 2 | `extract_document_data` | extraction | Document content (MinIO) | `document_verified` with extracted data |
| 3 | `cross_reference_registry` | — | EntityProfile (from context) | `document_verified` or `document_discrepancy` |
| 4 | `validate_document_authenticity` | — | Document metadata | `document_verified` or `document_discrepancy` |
| 5 | `generate_document_report` | — | All previous steps | — (produces report output) |

## Pipeline Position

```
Entity Resolution ──► Ownership & UBO Agent ──► Risk Assessment
                  │                              ▲
                  ├──► Screening Agent ───────────┤
                  │    (parallel)                 │
                  │                               │
                  └──► Document Analysis Agent ───┘
                       (triggered by document upload,
                        can run anytime after entity resolution)
```

## Definition of Done

- [ ] `DocumentAnalysisAgent` extends `BaseAgent` with 5 steps
- [ ] PDF text extraction via `pdf-parse`
- [ ] LLM classifies document type (certificate of incorporation, articles of association, proof of address, ID document, bank statement, etc.)
- [ ] LLM extracts structured data (entity name, registration number, addresses, dates, names)
- [ ] Extracted data compared against EntityProfile from Entity Resolution
- [ ] Comparison checks: entity name, registration number, address, incorporation date, director names
- [ ] Address comparison uses fuzzy matching for formatting differences
- [ ] Discrepancy severity levels: critical, warning, info
- [ ] Document authenticity validation (date checks, missing elements)
- [ ] Structured DocumentAnalysisReport produced
- [ ] Decision fragments: `document_verified` and `document_discrepancy`
- [ ] `documents.extracted_data` updated in database
- [ ] `documents.analysis_status` transitions: pending → analyzing → analyzed/failed
- [ ] Frontend Documents tab with drag-and-drop upload
- [ ] Side-by-side comparison view with match/mismatch highlighting
- [ ] Upload triggers agent automatically via WebSocket
