/**
 * `@civora/ai` — the reasoning layer.
 *
 * Scope: implementations of the `ReasoningProvider` port defined in
 * `@civora/domain`. The cloud adapter produces structured, schema-locked output
 * and the fixture adapter replays responses recorded from real calls, so tests
 * and offline development exercise the same code path without spending quota.
 *
 * Two rules bind everything in this package. Responses are validated against a
 * caller-supplied schema before they leave the adapter, and a narrative that
 * contains a numeral absent from the supplied facts is rejected — quantities
 * originate in the deterministic engines, never in a model.
 *
 * Not implemented yet. The provider adapters land with the Gemini reasoning
 * layer.
 */
export {};
