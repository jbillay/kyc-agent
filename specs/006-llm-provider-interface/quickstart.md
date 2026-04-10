# Quickstart: LLM Provider Interface and Routing Service

**Branch**: `006-llm-provider-interface` | **Date**: 2026-04-10

This guide covers how to wire up and use `LLMService` — for developers implementing agents or integrating new providers.

---

## Wiring at Application Startup

`LLMService` is a singleton instantiated once in the application bootstrap (e.g., `backend/src/index.js`), then injected into agents and services.

```javascript
'use strict';

const yaml = require('js-yaml');
const fs = require('fs');
const { LLMService } = require('./llm/llm-service');
const { PromptAdapterFactory } = require('./llm/prompt-adapter-factory');
const { OllamaProvider } = require('./llm/providers/ollama');
const { OpenAIProvider } = require('./llm/providers/openai');
const { eventStore } = require('./services/event-store'); // existing singleton

// 1. Load config
const llmConfig = yaml.load(fs.readFileSync('./config/llm.yaml', 'utf8'));

// 2. Instantiate factory and service
const promptAdapterFactory = new PromptAdapterFactory();
const llmService = new LLMService({ config: llmConfig, eventStore, promptAdapterFactory });

// 3. Register providers (only those whose config keys appear in llm.yaml)
llmService.registerProvider(new OllamaProvider({ baseUrl: process.env.OLLAMA_URL }));

// Opt-in: only register if API key is configured
if (process.env.OPENAI_API_KEY) {
  llmService.registerProvider(new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY }));
}

module.exports = { llmService };
```

---

## Making a Basic LLM Call (Agent Usage)

Agents receive `llmService` via constructor injection and call `complete()`.

```javascript
'use strict';

class EntityResolutionAgent extends BaseAgent {
  constructor({ llmService, ...rest }) {
    super(rest);
    this.llmService = llmService;
  }

  async resolveEntity(entityName, caseId) {
    const request = {
      taskType: 'extraction',
      messages: [
        {
          role: 'system',
          content: 'You are a KYC entity resolution specialist.',
        },
        {
          role: 'user',
          content: `Extract the canonical legal name and jurisdiction for: ${entityName}`,
        },
      ],
      // temperature defaults to 0.1 if omitted
    };

    const context = {
      caseId,
      agentType: 'entity-resolution',
      stepId: 'extract-entity-name',
    };

    const response = await this.llmService.complete(request, context);
    return response.content;
  }
}
```

---

## Requesting Structured JSON Output

When you need a parsed object back, attach a `structuredOutput` schema.

```javascript
const request = {
  taskType: 'extraction',
  messages: [
    { role: 'system', content: 'Extract entity data from the following document.' },
    { role: 'user', content: documentText },
  ],
  structuredOutput: {
    schema: {
      type: 'object',
      properties: {
        legalName: { type: 'string' },
        jurisdiction: { type: 'string' },
        registrationNumber: { type: 'string' },
      },
      required: ['legalName', 'jurisdiction'],
    },
    strict: true,
  },
};

const response = await llmService.complete(request, context);

// response.content — raw text from the model
// response.structured — parsed JavaScript object matching the schema
console.log(response.structured.legalName);
```

---

## Handling Errors

```javascript
try {
  const response = await llmService.complete(request, context);
  // use response
} catch (err) {
  if (err.code === 'NO_PROVIDER_AVAILABLE') {
    // No provider is configured/available for this task type
  } else if (err.code === 'LLM_CALL_FAILED') {
    // All retries and fallbacks exhausted; err.cause has the last underlying error
  } else if (err.code === 'STRUCTURED_OUTPUT_PARSE_ERROR') {
    // Provider returned non-JSON; err.rawContent has the raw text
  } else {
    throw err; // Unexpected — re-throw
  }
}
```

---

## Implementing a New Provider

1. Create `backend/src/llm/providers/<name>.js`
2. Implement the `LLMProvider` interface: `name`, `complete()`, `isAvailable()`, `listModels()`
3. Add provider config entry to `config/llm.yaml` (retry, timeout, max_concurrent)
4. Add routing entry to `config/llm.yaml` for each task type the provider should handle
5. Register the provider at startup: `llmService.registerProvider(new MyProvider(...))`

See `contracts/llm-provider-interface.md` for the full contract and example stub.

---

## Running Tests

```bash
# Run all LLM layer tests
cd backend && npx jest tests/backend/llm/

# Run a single test file
cd backend && npx jest tests/backend/llm/llm-service.test.js
```

Tests use mock providers (no real Ollama required) and a mock event store.
