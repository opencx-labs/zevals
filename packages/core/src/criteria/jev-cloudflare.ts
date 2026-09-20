import { z } from 'zod';
import { JevClient } from './jev';
import { postJson, QUESTION_KEY, requireCredential } from './jev-http';

/*
 * Cloudflare Workers AI. Shape taken from Cloudflare's docs on 2026-09-20
 * (`/ai/models/typesafe/jev/`), not yet verified against a live account. Caveats:
 * - The model id is `typesafe/jev` and the request nests `state` and `questions`
 *   under `input`, unlike every other provider, which puts them at the top level.
 * - The question `type` is `noul` and the answer field is `noul`, as on OpenRouter.
 * - `/client/v4` normally wraps success bodies in `{ result, success, errors }`, while
 *   the model docs show the answer unwrapped. Both are accepted below, so whichever
 *   the account returns, the probability is read correctly.
 * - Inside a Worker there is no API token to send: implement {@link JevClient} over
 *   `env.AI.run('typesafe/jev', { state, questions })` instead of using this client.
 */
const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const DEFAULT_MODEL = 'typesafe/jev';

const answerSchema = z.object({
  answers: z.object({
    [QUESTION_KEY]: z.object({ type: z.literal('noul'), noul: z.number() }),
  }),
});

/** Accepts the `/client/v4` envelope and the bare body the model docs show. */
const runResponseSchema = z.union([z.object({ result: answerSchema }), answerSchema]);

/** A {@link JevClient} backed by Cloudflare Workers AI. */
export function cloudflareJevClient(
  options: {
    /** Defaults to `process.env.CLOUDFLARE_ACCOUNT_ID`. */
    accountId?: string;
    /** Defaults to `process.env.CLOUDFLARE_API_TOKEN`. */
    apiToken?: string;
    /** Defaults to `typesafe/jev`. */
    model?: string;
    /** Defaults to `https://api.cloudflare.com/client/v4`. */
    baseUrl?: string;
    /** Defaults to the global `fetch`. */
    fetch?: typeof fetch;
  } = {},
): JevClient {
  const doFetch = options.fetch ?? fetch;

  return {
    kind: 'jev',

    async probability({ state, instructions, criteria }) {
      const accountId = requireCredential({
        value: options.accountId,
        option: 'accountId',
        envVar: 'CLOUDFLARE_ACCOUNT_ID',
        provider: 'Cloudflare account id',
      });
      const token = requireCredential({
        value: options.apiToken,
        option: 'apiToken',
        envVar: 'CLOUDFLARE_API_TOKEN',
        provider: 'Cloudflare API token',
      });

      const body = await postJson({
        url: `${options.baseUrl ?? DEFAULT_BASE_URL}/accounts/${accountId}/ai/run`,
        token,
        label: 'Cloudflare Workers AI run',
        fetch: doFetch,
        body: {
          model: options.model ?? DEFAULT_MODEL,
          input: {
            state,
            questions: { [QUESTION_KEY]: { type: 'noul', instructions, criteria } },
          },
        },
      });

      const parsed = runResponseSchema.parse(body);
      const answers = 'result' in parsed ? parsed.result.answers : parsed.answers;

      return { probability: answers[QUESTION_KEY].noul };
    },
  };
}
