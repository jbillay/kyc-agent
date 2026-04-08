# Screening Agent — Compile Screening List from Case Data

> GitHub Issue: [#31](https://github.com/jbillay/kyc-agent/issues/31)
> Epic: Screening Agent — Phase 1 (#30)
> Size: M (1-3 days) | Priority: Critical

## Context

Before screening can begin, the agent must assemble a list of every person and entity that needs to be checked against sanctions lists. This list is compiled from the Entity Resolution Agent's output (`EntityProfile`): the client entity itself, all current directors/officers, and all current shareholders (PSC entries). The same person may appear in multiple roles (e.g., both a director and a shareholder) — deduplication ensures each person is screened only once. Each screening subject carries metadata (role, entity type, DOB, nationality) used by downstream steps for hit evaluation.

## Requirements

### Functional

1. `ScreeningAgent` extends `BaseAgent`
2. Step `compile_screening_list`: collects all individuals and entities from the EntityProfile
3. Includes name variations and aliases where available
4. Deduplicates entries (same person appearing as both director and shareholder)
5. Produces a structured screening list with entity type (individual/entity) for each entry
6. Tracks the role(s) each subject plays (director, shareholder, entity)

### Non-Functional

- Compilation completes in under 1 second (no external calls)
- Handles edge cases: empty officers list, empty shareholders list, PSCs with no names

## Technical Design

### File: `backend/src/agents/screening/index.js`

```javascript
const { BaseAgent } = require('../base-agent');
const { FragmentType } = require('../decision-fragment');
const { compileScreeningSubjects } = require('./screening-list');
const { prompts } = require('./prompts');

/**
 * Screening Agent (Phase 1 — Sanctions Only).
 *
 * Screens all identified individuals and entities against OFAC SDN
 * and UK HMT sanctions lists. Uses LLM to evaluate potential hits.
 *
 * Steps:
 *   1. compile_screening_list — collect subjects from EntityProfile
 *   2. run_sanctions_screening — query OFAC + UK HMT for each subject
 *   3. evaluate_sanctions_hits — LLM confirms or dismisses each hit
 *   4. compile_screening_report — assemble ScreeningReport output
 */
class ScreeningAgent extends BaseAgent {
  /**
   * @param {Object} deps
   * @param {import('../../data-sources/screening/ofac').OFACProvider} deps.ofacProvider
   * @param {import('../../data-sources/screening/uk-hmt').UKHMTProvider} deps.ukhmtProvider
   * @param {import('../../llm/llm-service').LLMService} deps.llmService
   * @param {Object} [deps.config]
   * @param {number} [deps.config.matchThreshold=85]
   */
  constructor(deps) {
    super('screening', [
      'compile_screening_list',
      'run_sanctions_screening',
      'evaluate_sanctions_hits',
      'compile_screening_report',
    ]);

    this.ofacProvider = deps.ofacProvider;
    this.ukhmtProvider = deps.ukhmtProvider;
    this.llmService = deps.llmService;
    this.matchThreshold = deps.config?.matchThreshold || 85;

    // Shared state across steps
    this._subjects = [];
    this._screeningResults = new Map(); // subjectId → { subject, hits: [] }
    this._report = null;
  }

  /** @override */
  async executeStep(stepName, context, previousSteps) {
    switch (stepName) {
      case 'compile_screening_list':
        return this._compileScreeningList(context);
      case 'run_sanctions_screening':
        return this._runSanctionsScreening(context);
      case 'evaluate_sanctions_hits':
        return this._evaluateSanctionsHits(context);
      case 'compile_screening_report':
        return this._compileScreeningReport(context);
      default:
        throw new Error(`Unknown step: ${stepName}`);
    }
  }

  /** @override */
  async compileOutput(context, steps, fragments) {
    return this._report || { error: 'Screening did not complete' };
  }

  // ─── Step 1: Compile Screening List ───────────────

  async _compileScreeningList(context) {
    const entityProfile = context.existingData?.['entity-resolution'];

    if (!entityProfile) {
      throw new Error('Entity Resolution output not found in context — cannot compile screening list');
    }

    this._subjects = compileScreeningSubjects(entityProfile);

    // Initialize results map
    for (const subject of this._subjects) {
      this._screeningResults.set(subject.id, { subject, hits: [] });
    }

    const individuals = this._subjects.filter((s) => s.entityType === 'individual');
    const entities = this._subjects.filter((s) => s.entityType === 'entity');

    return {
      description: `Compiled screening list: ${this._subjects.length} subjects (${individuals.length} individuals, ${entities.length} entities)`,
      decisionFragments: [],
      llmCalls: [],
    };
  }

  // Steps 2-4 implemented in Stories #32 and #33
  async _runSanctionsScreening(context) { /* Story #32 */ }
  async _evaluateSanctionsHits(context) { /* Story #33 */ }
  async _compileScreeningReport(context) { /* Story #33 */ }
}

module.exports = { ScreeningAgent };
```

### File: `backend/src/agents/screening/screening-list.js`

```javascript
const crypto = require('crypto');

/**
 * @typedef {Object} ScreeningSubject
 * @property {string} id - Unique subject ID (hash of normalized name + type)
 * @property {string} name - Primary name
 * @property {string[]} aliases - Known alternate names
 * @property {'individual'|'entity'} entityType
 * @property {string[]} roles - e.g., ['director', 'shareholder']
 * @property {string} [dateOfBirth] - YYYY-MM format
 * @property {string} [nationality]
 * @property {string} [countryOfResidence]
 * @property {string} [registrationNumber] - For corporate subjects
 * @property {Object} source - Reference to origin data
 */

/**
 * Compile a deduplicated screening list from an EntityProfile.
 *
 * Sources:
 * - The entity itself (corporate screening)
 * - All current officers (individual screening)
 * - All current shareholders/PSCs (individual or corporate)
 *
 * Deduplication is by normalized name + entity type. When the same person
 * appears in multiple roles (e.g., director + shareholder), their roles
 * are merged into a single subject entry.
 *
 * @param {import('../entity-resolution/entity-profile').EntityProfile} entityProfile
 * @returns {ScreeningSubject[]}
 */
function compileScreeningSubjects(entityProfile) {
  /** @type {Map<string, ScreeningSubject>} dedup key → subject */
  const subjects = new Map();

  // 1. The entity itself
  _addSubject(subjects, {
    name: entityProfile.name,
    aliases: entityProfile.previousNames?.map((pn) => pn.name) || [],
    entityType: 'entity',
    roles: ['subject-entity'],
    registrationNumber: entityProfile.registrationNumber,
    source: { type: 'entity', registrationNumber: entityProfile.registrationNumber },
  });

  // 2. Current officers
  const currentOfficers = (entityProfile.officers || []).filter((o) => !o.resignedDate);
  for (const officer of currentOfficers) {
    _addSubject(subjects, {
      name: officer.name,
      aliases: [],
      entityType: 'individual',
      roles: [officer.role || 'officer'],
      dateOfBirth: officer.dateOfBirth,
      nationality: officer.nationality,
      source: { type: 'officer', role: officer.role, appointedDate: officer.appointedDate },
    });
  }

  // 3. Current shareholders / PSCs
  const currentShareholders = (entityProfile.shareholders || []).filter((s) => !s.ceasedDate);
  for (const sh of currentShareholders) {
    _addSubject(subjects, {
      name: sh.name,
      aliases: [],
      entityType: sh.type === 'individual' ? 'individual' : 'entity',
      roles: ['shareholder'],
      dateOfBirth: undefined,
      nationality: sh.nationality,
      countryOfResidence: sh.countryOfResidence,
      registrationNumber: sh.registrationNumber,
      source: {
        type: 'shareholder',
        ownershipPercentage: sh.ownershipPercentage,
        naturesOfControl: sh.naturesOfControl,
      },
    });
  }

  return Array.from(subjects.values());
}

/**
 * Add or merge a subject into the map.
 *
 * If a subject with the same dedup key already exists, merge roles and aliases.
 */
function _addSubject(subjects, data) {
  const key = _dedupKey(data.name, data.entityType);
  const existing = subjects.get(key);

  if (existing) {
    // Merge roles
    for (const role of data.roles) {
      if (!existing.roles.includes(role)) {
        existing.roles.push(role);
      }
    }
    // Merge aliases
    for (const alias of data.aliases) {
      if (alias && !existing.aliases.includes(alias)) {
        existing.aliases.push(alias);
      }
    }
    // Fill in missing metadata
    if (!existing.dateOfBirth && data.dateOfBirth) existing.dateOfBirth = data.dateOfBirth;
    if (!existing.nationality && data.nationality) existing.nationality = data.nationality;
    if (!existing.countryOfResidence && data.countryOfResidence) existing.countryOfResidence = data.countryOfResidence;
  } else {
    subjects.set(key, {
      id: crypto.randomUUID(),
      name: data.name,
      aliases: data.aliases.filter(Boolean),
      entityType: data.entityType,
      roles: [...data.roles],
      dateOfBirth: data.dateOfBirth || undefined,
      nationality: data.nationality || undefined,
      countryOfResidence: data.countryOfResidence || undefined,
      registrationNumber: data.registrationNumber || undefined,
      source: data.source,
    });
  }
}

/**
 * Generate a deduplication key from normalized name + entity type.
 *
 * @param {string} name
 * @param {'individual'|'entity'} entityType
 * @returns {string}
 */
function _dedupKey(name, entityType) {
  const normalized = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${entityType}:${normalized}`;
}

module.exports = { compileScreeningSubjects };
```

### Deduplication Logic

The same person may appear multiple times in registry data:

| Source | Name | Role |
|--------|------|------|
| Officers | "John Smith" | director |
| PSC | "JOHN SMITH" | shareholder |

Deduplication normalizes names (lowercase, strip diacritics, collapse spaces) and keys by `entityType:normalizedName`. When duplicates are found, roles are merged:

```
Before: 2 entries — "John Smith" (director), "JOHN SMITH" (shareholder)
After:  1 entry  — "john smith" (director, shareholder)
```

### Screening Subject Shape

```javascript
{
  id: 'uuid',
  name: 'John Smith',
  aliases: [],
  entityType: 'individual',
  roles: ['director', 'shareholder'],
  dateOfBirth: '1975-03',
  nationality: 'British',
  countryOfResidence: undefined,
  registrationNumber: undefined,
  source: { type: 'officer', role: 'director', appointedDate: '2020-01-15' }
}
```

## Acceptance Criteria

- [ ] `ScreeningAgent` extends `BaseAgent` with 4 step names
- [ ] Step `compile_screening_list` collects subjects from `EntityProfile`
- [ ] Client entity included as `entity` type subject
- [ ] All current officers included as `individual` subjects
- [ ] All current shareholders included with correct `entityType` (individual or corporate)
- [ ] Resigned officers excluded
- [ ] Ceased shareholders excluded
- [ ] Deduplication: same person as director + shareholder → single entry with merged roles
- [ ] Dedup is case-insensitive and diacritic-insensitive
- [ ] Previous entity names included as aliases
- [ ] Each subject has: id, name, aliases, entityType, roles, optional DOB/nationality
- [ ] Missing EntityProfile in context throws clear error
- [ ] Step description includes subject count breakdown (individuals vs entities)

## Dependencies

- **Depends on**: #21 (BaseAgent), #22 (Decision fragments), #27-#28 (Entity Resolution — provides EntityProfile)
- **Blocks**: #32 (Sanctions screening — needs the compiled subject list)

## Testing Strategy

1. **Full compilation**: EntityProfile with 3 officers + 2 shareholders + entity → verify all collected
2. **Deduplication**: Same person as director and shareholder → verify single entry with both roles
3. **Case-insensitive dedup**: "JOHN SMITH" (officer) + "John Smith" (PSC) → deduplicated
4. **Diacritic dedup**: "José García" (officer) + "Jose Garcia" (PSC) → deduplicated
5. **Resigned officers excluded**: 2 current + 1 resigned → verify only 2 in list
6. **Ceased shareholders excluded**: 2 current + 1 ceased → verify only 2 in list
7. **Corporate shareholder**: PSC with type "corporate" → entityType is "entity"
8. **Individual shareholder**: PSC with type "individual" → entityType is "individual"
9. **Entity itself**: Verify client entity included with role "subject-entity"
10. **Previous names as aliases**: Entity with 2 previous names → verify included as aliases
11. **Metadata merging**: Director has DOB, same person as shareholder has nationality → both present
12. **Empty input**: EntityProfile with no officers/shareholders → verify only entity itself in list
13. **Missing EntityProfile**: No entity-resolution data in context → verify clear error thrown
