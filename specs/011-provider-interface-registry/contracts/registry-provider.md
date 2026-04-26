# Contract: RegistryProvider

**Layer**: 2 — Data Integration (`backend/src/data-sources/registry/`)  
**Consumers**: Layer 3 agents (entity resolution, ownership/UBO tracing)  
**Source file**: `backend/src/data-sources/registry/types.js`

---

## Interface Contract

A `RegistryProvider` is any JavaScript object that satisfies all of the following:

```
name          : string         (non-empty)
jurisdictions : string[]       (non-empty; ISO 3166-1 alpha-2 codes)
searchEntity        (query)    → Promise<EntitySearchResult[]>
getEntityDetails    (entityId) → Promise<EntityDetails>
getOfficers         (entityId) → Promise<Officer[]>
getShareholders     (entityId) → Promise<Shareholder[]>
getFilingHistory    (entityId) → Promise<Filing[]>
getEntityStatus     (entityId) → Promise<EntityStatus>
```

All six methods are **async** (return Promises). Implementations MUST be **stateless**.

---

## Registration

```javascript
const factory = new RegistryFactory();
factory.register(myProvider); // validates contract; throws INVALID_PROVIDER if incomplete
```

Calling `register()` with a provider whose jurisdictions overlap an existing registration emits a structured `console.warn` with event `REGISTRY_PROVIDER_OVERWRITTEN` and overwrites.

---

## Error Contract

All six methods MUST throw typed errors on failure:

```javascript
throw Object.assign(
  new Error('Human-readable description'),
  { code: 'PROVIDER_UNAVAILABLE', provider: 'my-provider-name' }
);
```

| `code` | Meaning |
|--------|---------|
| `PROVIDER_UNAVAILABLE` | Cannot reach the underlying data source |
| `RATE_LIMITED` | Source is rate-limiting requests |
| `ENTITY_NOT_FOUND` | Valid call, no matching entity in the registry |
| `INVALID_RESPONSE` | Source returned unexpected / malformed data |

---

## rawData Requirement

Every response object (EntitySearchResult, EntityDetails, Officer, Shareholder, Filing, EntityStatus) MUST include a `rawData` field containing the complete, unmodified payload from the external source. This is required for audit reproducibility under Constitution Principle I.

---

## Implementing a New Provider

1. Create `backend/src/data-sources/registry/<provider-name>.js`
2. Export an object (or instance) with all 8 required members
3. Set `jurisdictions` to the ISO codes the provider covers
4. Implement all 6 methods; throw typed errors on failure; include `rawData` in every response
5. Register in application startup: `registryFactory.register(myProvider)`

---

## Factory Error Contract

```javascript
const factory = new RegistryFactory();
factory.getProvider('XX'); 
// throws: { message: 'No registry provider registered for jurisdiction: XX',
//           code: 'NO_REGISTRY_PROVIDER', jurisdiction: 'XX' }
```
