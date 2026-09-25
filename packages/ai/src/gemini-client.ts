import { GoogleGenAI } from '@google/genai';

import type { InteractionClient, ModelInteractionResult } from './gemini-provider';
import type { ModelInteractionRequest } from './request';

/**
 * The live client: the only place in the platform that holds an API key or names
 * the vendor's SDK.
 *
 * It is deliberately a factory rather than a class, and it is deliberately the
 * thinnest possible translation — build a client, make the call, hand back the
 * text and whatever token counts came with it. Everything the platform promises
 * about model output (validation, retry, caching, telemetry) lives in the
 * provider, so this file can be replaced by the next SDK generation without
 * touching a promise.
 *
 * Nothing here is on the browser's side of the boundary. The key is read from the
 * server's environment, and the request is made from the server; a client bundle
 * that contained a key would be a key given away.
 */

export interface GeminiClientOptions {
  /** Read from the server environment; never sent to a browser. */
  readonly apiKey: string;
  /** Pinned deliberately. An alias that hot-swaps mid-evaluation is an unexplained change. */
  readonly model: string;
}

export function createGeminiClient(options: GeminiClientOptions): InteractionClient {
  const ai = new GoogleGenAI({ apiKey: options.apiKey });

  return {
    model: options.model,
    async create(request: ModelInteractionRequest): Promise<ModelInteractionResult> {
      const interaction = await ai.interactions.create(request);

      return { output_text: interaction.output_text, usage: interaction.usage };
    },
  };
}
