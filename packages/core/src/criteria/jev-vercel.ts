import { z } from 'zod';
import { JevClient } from './jev';
import { postJson, QUESTION_KEY, requireCredential, resolveFetch } from './jev-http';

/*
 * Vercel AI Gateway's evaluation API. Shape taken from Vercel's docs on 2026-09-20
 * (`/docs/ai-gateway/modalities/evaluation`). Caveats:
 * - The question `type` is `boolean` and the answer field is `probability`. Jev's own
 *   naming (`noul`) reaches the same endpoint only through the TypeSafe-compatible
 *   base URL, `https://ai-gateway.vercel.sh/typesafe/v1/systemone`.
 * - `criteria` keeps the `{ true, false }` shape, as on every other provider.
 * - `typesafe-ai/jev` is not version-pinned, and a threshold is calibrated against a
 *   specific version. Pass `model` to pin once Vercel exposes a versioned id.
 * - Evaluation is not served by the OpenAI-, Anthropic- or Cohere-compatible endpoints;
 *   it needs this one. Through the AI SDK it would need v7, which is why this client
 *   talks to the HTTP API directly and keeps zod as core's only dependency.
 */
const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh';
const DEFAULT_MODEL = 'typesafe-ai/jev';

const evaluateResponseSchema = z.object({
  answers: z.object({
    [QUESTION_KEY]: z.object({ type: z.literal('boolean'), probability: z.number() }),
  }),
});

/** A {@link JevClient} backed by Vercel AI Gateway's evaluation API. */
export function vercelJevClient(
  options: {
    /** Defaults to `process.env.AI_GATEWAY_API_KEY`. A Vercel OIDC token also works. */
    apiKey?: string;
    /** Defaults to `typesafe-ai/jev`. */
    model?: string;
    /** Defaults to `https://ai-gateway.vercel.sh`. */
    baseUrl?: string;
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
        envVar: 'AI_GATEWAY_API_KEY',
        provider: 'Vercel AI Gateway API key',
      });

      const body = await postJson({
        url: `${options.baseUrl ?? DEFAULT_BASE_URL}/v1/evaluate`,
        token,
        label: 'Vercel AI Gateway evaluate',
        fetch: resolveFetch(options.fetch),
        body: {
          model: options.model ?? DEFAULT_MODEL,
          state,
          questions: { [QUESTION_KEY]: { type: 'boolean', instructions, criteria } },
        },
      });

      return { probability: evaluateResponseSchema.parse(body).answers[QUESTION_KEY].probability };
    },
  };
}
