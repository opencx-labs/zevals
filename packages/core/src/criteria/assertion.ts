import { z } from 'zod';
import { Judge } from '../eval-runner';
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
 */
export const aiAssertion: (options: AiAssertionOptions) => Criterion<boolean> = (options) => {
  const { judge } = options;

  if (isJevClient(judge)) {
    const threshold = jevThreshold(options);

    return {
      name: options.prompt,
      evaluate: (params) =>
        evaluateWithJev({
          ...options,
          client: judge,
          messages: scopeMessages({ messages: params.messages, scope: options.scope }),
          threshold,
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
      const prompt = `
    You are a judge.

    You evaluate the truth value of an assertion based on a given prompt.
    The prompt is a statement about a conversation between the AI assistant and the user.

    You need to determine if the response is a correct answer to the prompt.

    Assertion prompt:
    <assertion-prompt>
    ${options.prompt}
    </assertion-prompt>

    Conversation between AI and user:
    <conversation>
    ${params.messages
      .map((message) => {
        return `<${message.role}>${message.content.toString()}</${message.role}>`;
      })
      .join('\n\n')}
    </conversation>
    `;

      const {
        output: { verdict, reason },
      } = await judge.invoke({
        messages: [{ role: 'system', content: prompt }],
        schema: z.object({
          verdict: z.boolean().describe('True if the assertion is correct, false otherwise'),

          reason: z
            .string()
            .nullable()
            .describe(
              'Brief explanation of the verdict, citing the relevant parts of the conversation. Especially important when the assertion fails.',
            ),
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
