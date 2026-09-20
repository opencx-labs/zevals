import { z } from 'zod';
import { JevClient } from './jev';
import { postJson, QUESTION_KEY, requireCredential, resolveFetch } from './jev-http';

/*
 * OpenRouter's decisions API. Verified 2026-09-18. Caveats:
 * - The path is **alpha** and may change.
 * - The question `type` must be `noul` (`boolean` is rejected with
 *   `400 Invalid discriminator value. Expected 'noul' | 'choice' | 'score'`),
 *   and the answer field is `noul`, not `probability`.
 * - Jev is a decisions model: `/v1/chat/completions` rejects it.
 * - The context limit is 32k tokens. Long transcripts are rejected, so scope them
 *   (e.g. `scope: 'lastAssistantTurn'`).
 */
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_MODEL = 'typesafe/jev-1.13';

const decisionsResponseSchema = z.object({
  answers: z.object({
    [QUESTION_KEY]: z.object({ type: z.literal('noul'), noul: z.number() }),
  }),
});

/** A {@link JevClient} backed by OpenRouter's decisions API. */
export function openRouterJevClient(
  options: {
    /** Defaults to `process.env.OPENROUTER_API_KEY`. */
    apiKey?: string;
    /** Defaults to `typesafe/jev-1.13`. */
    model?: string;
    /** Defaults to the global `fetch`. */
    fetch?: typeof fetch;
  } = {},
): JevClient {
  return {
    kind: 'jev',

    async probability({ state, instructions, criteria }) {
      const token = requireCredential({
        value: options.apiKey,
        option: 'apiKey',
        envVar: 'OPENROUTER_API_KEY',
        provider: 'OpenRouter API key',
      });

      const body = await postJson({
        url: DECISIONS_URL,
        token,
        label: 'OpenRouter decisions',
        fetch: resolveFetch(options.fetch),
        body: {
          model: options.model ?? DEFAULT_MODEL,
          state,
          questions: { [QUESTION_KEY]: { type: 'noul', instructions, criteria } },
        },
      });

      return { probability: decisionsResponseSchema.parse(body).answers[QUESTION_KEY].noul };
    },
  };
}
