# Research: Data Source Provider Interface and Registry Abstraction

**Branch**: `011-provider-interface-registry` | **Date**: 2026-04-23

## No NEEDS CLARIFICATION Items

The spec arrived fully resolved from `/speckit-clarify`. No unknowns required external research. The findings below confirm existing project patterns and inform implementation decisions.

---

## Finding 1: JSDoc Interface Pattern (from existing Layer 1 code)

**Decision**: Define all provider interfaces and type shapes exclusively via JSDoc `@typedef` blocks. Export only `{}` from each types file (the typedefs are consumed by IDEs and documentation tools, not at runtime).

**Rationale**: The LLM layer (`backend/src/llm/`) already uses this pattern — see `llm-service.js` and provider files. JSDoc typedefs give IDE autocomplete and type checking without a TypeScript build step, consistent with the project's "no TypeScript" constraint.

**Alternatives considered**: TypeScript interfaces (rejected — project constraint), runtime schema validation with Joi/Zod (rejected — these are pure contracts, not runtime validators; Joi/Zod is reserved for API boundary validation per CLAUDE.md).

---

## Finding 2: Typed Error Shape (from clarification Q1)

**Decision**: Provider implementations MUST throw plain Error objects augmented with a `code` property and a `provider` property, following the exact pattern established by `RegistryFactory` for `NO_REGISTRY_PROVIDER`.

```javascript
// Canonical error shape:
throw Object.assign(
  new Error('Human-readable message'),
  { code: 'PROVIDER_UNAVAILABLE', provider: 'companies-house' }
);
```

**Standard error codes**:
- `PROVIDER_UNAVAILABLE` — cannot reach the underlying source
- `RATE_LIMITED` — source is rate-limiting requests
- `ENTITY_NOT_FOUND` — valid call but no matching entity exists
- `INVALID_RESPONSE` — source returned unexpected / malformed data

**Rationale**: This pattern is already in the spec's `RegistryFactory` design (`Object.assign(new Error(...), { code, jurisdiction })`). Using the same pattern across both the factory and all provider implementations means agent error-handling code can use a single `err.code` switch regardless of where the error originated.

**Alternatives considered**: Custom Error subclasses (rejected — adds class hierarchy complexity for no behavioral gain in JS); generic Error with message parsing (rejected — not machine-readable for agents).

---

## Finding 3: Factory Registration Validation (from clarification Q3)

**Decision**: `RegistryFactory.register()` validates that the supplied provider has all required fields (`name`, `jurisdictions`) and all six required methods at registration time. Throws `INVALID_PROVIDER` error if contract is not met.

**Required RegistryProvider members to validate**:
- Properties: `name` (string), `jurisdictions` (non-empty array)
- Methods: `searchEntity`, `getEntityDetails`, `getOfficers`, `getShareholders`, `getFilingHistory`, `getEntityStatus`

**Rationale**: Fail-fast at application startup (where `register()` is called) rather than at runtime during a live KYC case. Missing methods surface immediately in dev/test, not in production.

---

## Finding 4: Duplicate Jurisdiction Warning (from clarification Q2)

**Decision**: When `register()` is called for a jurisdiction that already has a provider, emit a structured warning via `console.warn` with a JSON-serialisable payload, then overwrite.

```javascript
console.warn(JSON.stringify({
  event: 'REGISTRY_PROVIDER_OVERWRITTEN',
  jurisdiction: code,
  previous: existingProvider.name,
  replacement: provider.name,
}));
```

**Rationale**: `console.warn` is the appropriate level — visible in structured log pipelines (Docker logs, cloud logging) but does not throw. JSON payload makes it machine-parseable for log alerting rules. Does not halt startup.

---

## Finding 5: Test File Location and Pattern

**Decision**: Place tests at `tests/backend/data-sources/registry-factory.test.js`, following the `tests/backend/<module>/` convention used for `tests/backend/llm/llm-service.test.js`.

**Test scope**: Unit tests only — mock providers used throughout. No real HTTP calls. Test cases directly match the 5 acceptance scenarios in User Story 1.
