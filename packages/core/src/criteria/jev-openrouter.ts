import { z } from 'zod';
import { JevClient } from './jev';

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
    q0: z.object({ type: z.literal('noul'), noul: z.number() }),
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
  const doFetch = options.fetch ?? fetch;

  return {
    kind: 'jev',

    async noul({ state, instructions, criteria }) {
      const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
      if (!apiKey)
        throw new Error('OpenRouter API key missing: pass apiKey or set OPENROUTER_API_KEY');

      const response = await doFetch(DECISIONS_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: options.model ?? DEFAULT_MODEL,
          state,
          questions: { q0: { type: 'noul', instructions, criteria } },
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OpenRouter decisions request failed: ${response.status} ${await bodyExcerpt(response)}`,
        );
      }

      const body = decisionsResponseSchema.parse(await response.json());

      return { probability: body.answers.q0.noul };
    },
  };
}

/** Max characters of an error response body kept in the thrown error (and so in test logs). */
const ERROR_BODY_LIMIT = 500;

/**
 * Reads at most {@link ERROR_BODY_LIMIT} characters of the body, whitespace-collapsed.
 * Best effort: a failing stream yields what was read so far, never an error that would
 * replace the HTTP status in the caller's message.
 */
async function bodyExcerpt(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let text = '';
  try {
    while (text.length <= ERROR_BODY_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
  } catch {
    // Keep whatever was read; the status code is what matters.
  }

  text = text.replace(/\s+/g, ' ').trim();

  return text.length > ERROR_BODY_LIMIT ? `${text.slice(0, ERROR_BODY_LIMIT)}…` : text;
}
