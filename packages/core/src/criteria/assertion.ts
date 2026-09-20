import { z } from 'zod';
import { Judge } from '../eval-runner';
import { formatMessage } from '../format';
import {
  Criterion,
  CriterionEvaluationParams,
  CriterionResult,
  CriterionScope,
  scopeMessages,
} from './criterion';
import { evaluateWithJev, isJevClient, JevAssertionOptions, JevClient, jevThreshold } from './jev';

export type AiAssertionOptions = {
  prompt: string;
  /** Which part of the transcript the judge sees. Defaults to `fullTranscript`. */
  scope?: CriterionScope;
} & (
  | ({ judge: JevClient } & JevAssertionOptions)
  // Jev-only options are rejected for LLM judges rather than silently ignored.
  | ({ judge: Judge } & { [K in keyof JevAssertionOptions]?: never })
);

/**
 * Asks an AI whether `prompt` holds for the conversation.
 *
 * `judge` is either an LLM {@link Judge}, which returns a verdict with a written reason, or a
 * {@link JevClient}, which returns a calibrated probability compared against `threshold`.
 * The Jev-only options are {@link JevAssertionOptions}.
 *
 * Errors: with a Jev judge, a failed call or malformed answer is returned as a failed result
 * with `error` set. An LLM judge's errors are thrown, as before Jev was supported.
 */
export const aiAssertion: (options: AiAssertionOptions) => Criterion<boolean> = (options) => {
  const { judge } = options;

  if (isJevClient(judge)) {
    const threshold = jevThreshold(options);

    return {
      name: options.prompt,
      evaluate: (params) =>
        evaluateWithJev({
          client: judge,
          prompt: options.prompt,
          messages: scopeMessages({ messages: params.messages, scope: options.scope }),
          threshold,
          criteria: options.criteria,
          explainFailures: options.explainFailures,
        }),
    };
  }

  return {
    name: options.prompt,

    async evaluate(rawParams: CriterionEvaluationParams): Promise<CriterionResult<boolean>> {
      const params = {
        ...rawParams,
        messages: scopeMessages({ messages: rawParams.messages, scope: options.scope }),
      };
      const instructions = `
    You are a judge. A developer testing an AI assistant has written an assertion about a
    conversation between the assistant and a user. Decide whether the assertion is true of that
    conversation.

    In the conversation, each line starts with the speaker's role. "[tool call]" lines are tools the
    assistant called, and "[tool:name]" lines are the results those tools returned.
    `;

      const input = `
    Assertion prompt:
    <assertion-prompt>
    ${options.prompt}
    </assertion-prompt>

    Conversation between AI and user:
    <conversation>
    ${params.messages.flatMap(formatMessage).join('\n')}
    </conversation>
    `;

      const {
        output: { verdict, reason },
      } = await judge.invoke({
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: input },
        ],
        schema: z.object({
          // `reason` is first on purpose: the judge must state its reasoning before it
          // commits to a boolean. With `verdict` first, the model has been observed to
          // emit a verdict and then reason its way to the opposite conclusion.
          reason: z
            .string()
            .nullable()
            .describe(
              'Brief explanation of the verdict, citing the relevant parts of the conversation. Especially important when the assertion fails.',
            ),

          verdict: z.boolean().describe('True if the assertion is correct, false otherwise'),
        }),
      });

      return {
        output: verdict,
        reason: reason?.trim() || undefined,
        status: verdict ? 'success' : 'failure',
      };
    },
  };
};
