import { z } from 'zod';
import { Judge } from '../eval-runner';
import {
  Criterion,
  CriterionEvaluationParams,
  CriterionResult,
  CriterionScope,
  scopeMessages,
} from './criterion';

export const aiAssertion: (options: {
  prompt: string;
  judge: Judge;
  /** Which part of the transcript the judge sees. Defaults to `fullTranscript`. */
  scope?: CriterionScope;
}) => Criterion<boolean> = (options) => ({
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
    } = await options.judge.invoke({
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
});
