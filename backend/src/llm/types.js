'use strict';

/**
 * @typedef {Object} LLMMessage
 * @property {'system'|'user'|'assistant'} role
 * @property {string} content
 */

/**
 * @typedef {Object} LLMStructuredOutput
 * @property {Object} schema - JSON Schema for the expected output
 * @property {boolean} [strict=true] - Whether to enforce schema compliance
 */

/**
 * @typedef {'reasoning'|'extraction'|'screening'|'classification'|'summarization'} LLMTaskType
 *
 * Task type semantics:
 * - reasoning:       Complex analysis, risk assessment, narrative generation
 * - extraction:      Data extraction from documents, structured parsing
 * - screening:       Sanctions/PEP/adverse media analysis
 * - classification:  Risk classification, entity type detection
 * - summarization:   Generating summaries, narratives
 */

/**
 * @typedef {Object} LLMRequest
 * @property {LLMMessage[]} messages
 * @property {LLMTaskType} taskType
 * @property {number} [temperature=0.1]
 * @property {number} [maxTokens]
 * @property {LLMStructuredOutput} [structuredOutput]
 */

/**
 * @typedef {Object} LLMResponse
 * @property {string} content - Raw text response
 * @property {Object} [structured] - Parsed structured output (if schema was provided)
 * @property {{ promptTokens: number, completionTokens: number, totalTokens: number }} usage
 * @property {string} model - Actual model used
 * @property {string} provider - Provider name
 * @property {number} latencyMs
 */

/**
 * Context passed alongside every LLM request for logging purposes.
 *
 * CANONICAL CALLING CONVENTION:
 *   llmService.complete(request, context)
 *
 *   Where `request` is an LLMRequest (with taskType, messages, and optionally
 *   structuredOutput for JSON responses), and `context` is an LLMCallContext.
 *
 *   All agents MUST use `structuredOutput` (not `responseFormat` or `json`)
 *   when requesting structured JSON output from the LLM.
 *
 * @typedef {Object} LLMCallContext
 * @property {string} caseId
 * @property {string} agentType
 * @property {string} stepId
 */

/**
 * LLM Provider Interface — every provider must implement these methods.
 * @typedef {Object} LLMProvider
 * @property {string} name
 * @property {(request: LLMRequest) => Promise<LLMResponse>} complete
 * @property {() => Promise<boolean>} isAvailable
 * @property {() => Promise<string[]>} listModels
 */

const TASK_TYPES = ['reasoning', 'extraction', 'screening', 'classification', 'summarization'];

module.exports = { TASK_TYPES };
