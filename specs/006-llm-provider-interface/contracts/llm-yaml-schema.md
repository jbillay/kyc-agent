# Contract: config/llm.yaml Schema

**File**: `config/llm.yaml` (created by this feature)  
**Loaded by**: Config loader (dependency), consumed by `LLMService` constructor  
**Type**: Configuration contract

---

## Full Annotated Schema

```yaml
# Required. Name of the provider to use by default.
# Must match a key defined under `providers` below.
default_provider: <string>

providers:
  # One entry per registered provider. Key must match LLMProvider.name.
  <provider-name>:
    retry:
      # Maximum number of attempts before giving up on this provider.
      # Includes the first attempt. Minimum: 1. Default: 3.
      max_attempts: <integer>

      # Base wait time in milliseconds before the first retry.
      # Each subsequent retry doubles this value (exponential backoff).
      # Rate-limit errors (429) use 2× this multiplier on top of the exponential schedule.
      # Default: 1000
      backoff_ms: <integer>

    # Maximum wall-clock time in milliseconds for a single provider.complete() call.
    # If exceeded, the request is aborted and treated as a transient error (retried).
    # Default: 120000 (2 minutes)
    timeout_ms: <integer>

    # Maximum number of concurrent requests this provider will accept simultaneously.
    # Requests beyond this limit queue until a slot is released.
    # Default: 4
    max_concurrent: <integer>

    # Maximum time in milliseconds for a provider.isAvailable() check to complete.
    # If exceeded, the provider is treated as unavailable for this routing cycle.
    # Default: 3000
    availability_timeout_ms: <integer>

routing:
  # One entry per provider. Key must match a key under `providers`.
  # Each sub-key is a task type. Value is the model string passed to provider.complete().
  # All five task types must be listed for each provider that is used as a fallback.
  # The default_provider routing entry must cover all five task types.
  <provider-name>:
    reasoning: <model-string>
    extraction: <model-string>
    screening: <model-string>
    classification: <model-string>
    summarization: <model-string>
```

---

## Validation Rules

- `default_provider` must be a non-empty string matching a key in `providers`
- Every provider listed in `routing` must also appear in `providers`
- `default_provider` routing entry must include all five task types
- Fallback provider routing entries may cover a subset of task types (only task types with entries are eligible for fallback routing)
- `retry.max_attempts` must be ≥ 1
- `retry.backoff_ms` must be > 0
- `timeout_ms` must be > 0
- `max_concurrent` must be ≥ 1
- `availability_timeout_ms` must be > 0

---

## Minimal Working Example (Ollama only)

```yaml
default_provider: ollama

providers:
  ollama:
    retry:
      max_attempts: 3
      backoff_ms: 1000
    timeout_ms: 120000
    max_concurrent: 4
    availability_timeout_ms: 3000

routing:
  ollama:
    reasoning: llama3.1:70b
    extraction: llama3.1:8b
    screening: llama3.1:8b
    classification: llama3.1:8b
    summarization: llama3.1:8b
```

---

## Full Example (Ollama default, OpenAI fallback)

```yaml
default_provider: ollama

providers:
  ollama:
    retry:
      max_attempts: 3
      backoff_ms: 1000
    timeout_ms: 120000
    max_concurrent: 4
    availability_timeout_ms: 3000
  openai:
    retry:
      max_attempts: 2
      backoff_ms: 500
    timeout_ms: 30000
    max_concurrent: 20
    availability_timeout_ms: 2000

routing:
  ollama:
    reasoning: llama3.1:70b
    extraction: llama3.1:8b
    screening: llama3.1:8b
    classification: llama3.1:8b
    summarization: llama3.1:8b
  openai:
    reasoning: gpt-4o
    extraction: gpt-4o-mini
    screening: gpt-4o-mini
    classification: gpt-4o-mini
    summarization: gpt-4o-mini
```
