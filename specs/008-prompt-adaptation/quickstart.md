# Quickstart: Prompt Adaptation System (008)

## Scope

This feature touches four source files and one test file. All changes are in
`backend/src/llm/`. No new files are created.

## Files to modify

| File | Change |
|------|--------|
| `backend/src/llm/prompt-adapters/llama.js` | Add default system message if none present |
| `backend/src/llm/prompt-adapters/mistral.js` | Flush system-only messages; add null schema guard |
| `backend/src/llm/prompt-adapters/default.js` | Add null schema guard |
| `backend/src/llm/prompt-adapter-factory.js` | Add `mixtral*` prefix check |
| `backend/src/llm/llm-service.js` | Accept optional `logger`; log adapter selection at debug level |
| `tests/backend/llm/prompt-adapters/adapters.test.js` | Add missing test cases |

## Run tests

```bash
cd backend && npm test
# or a single file:
cd backend && npx jest ../tests/backend/llm/prompt-adapters/adapters.test.js
```

## Verify adapter selection

```bash
# Quick smoke test from the backend directory
node -e "
  const { PromptAdapterFactory } = require('./src/llm/prompt-adapter-factory');
  const f = new PromptAdapterFactory();
  console.log(f.getAdapter('mistral:7b').constructor.name);    // MistralAdapter
  console.log(f.getAdapter('mixtral:8x7b').constructor.name);  // MistralAdapter
  console.log(f.getAdapter('llama3.1:8b').constructor.name);   // LlamaAdapter
  console.log(f.getAdapter('gpt-4o').constructor.name);        // DefaultAdapter
  console.log(f.getAdapter('').constructor.name);              // DefaultAdapter
"
```

## No migration or deployment steps required

This feature modifies in-process logic only. No schema changes, no config changes,
no Docker rebuild needed beyond the normal `docker-compose up --build`.
