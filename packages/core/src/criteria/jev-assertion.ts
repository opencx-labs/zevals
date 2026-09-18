import { z } from 'zod';
import { formatMessage, Judge } from '../eval-runner';
import {
  Criterion,
  CriterionEvaluationParams,
  CriterionResult,
  CriterionScope,
  scopeMessages,
} from './criterion';

/**
 * Minimal client for TypeSafe's Jev model. Answers a single `noul` question: the
 * calibrated probability that `instructions` holds for `state`.
 *
 * Implement it over any transport; {@link openRouterJevClient} is provided for OpenRouter.
 */
export interface JevClient {
  noul(params: {
    state: unknown;
    instructions: string;
    criteria?: { true?: string; false?: string };
  }): Promise<{ probability: number }>;
}

/** Probabilities this close to the threshold are flagged as borderline in `reason`. */
const BORDERLINE_MARGIN = 0.05;

const jevAnswerSchema = z.object({ probability: z.number().min(0).max(1) });

const explanationSchema = z.object({
  reason: z.string().describe('Brief explanation of why the assertion does not hold.'),
});

/**
 * Like {@link aiAssertion}, but the verdict comes from Jev instead of an LLM judge:
 * a calibrated probability compared against `threshold`, with no generated text.
 *
 * `reason` always carries the probability. Pass `explainFailures` to also get prose from
 * an LLM judge — it is only invoked when the assertion fails.
 */
export const jevAssertion: (options: {
  /** The assertion about the conversation — same meaning as `aiAssertion`'s `prompt`. */
  prompt: string;
  client: JevClient;
  /** Which part of the transcript Jev sees. Defaults to `fullTranscript`. */
  scope?: CriterionScope;
  /** The assertion passes when the probability is at or above this. Defaults to `0.5`. */
  threshold?: number;
  /** Optional descriptions of what makes the assertion true / false. */
  criteria?: { true?: string; false?: string };
  /** On a failing verdict only, ask this judge to explain the failure. */
  explainFailures?: Judge;
}) => Criterion<boolean> = (options) => {
  const threshold = options.threshold ?? 0.5;

  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError(`jevAssertion threshold must be between 0 and 1, got ${threshold}`);
  }

  return {
    name: options.prompt,

    async evaluate(params: CriterionEvaluationParams): Promise<CriterionResult<boolean>> {
      const messages = scopeMessages({ messages: params.messages, scope: options.scope });
      const conversation = messages.flatMap(formatMessage).join('\n');

      let probability: number;
      try {
        const answer = await options.client.noul({
          state: { conversation },
          instructions: options.prompt,
          ...(options.criteria ? { criteria: options.criteria } : {}),
        });
        probability = jevAnswerSchema.parse(answer).probability;
      } catch (error) {
        return { output: false, status: 'failure', reason: 'jev call failed', error };
      }

      const verdict = probability >= threshold;
      const borderline =
        Math.abs(probability - threshold) < BORDERLINE_MARGIN ? ', borderline' : '';
      const summary = `jev p=${round(probability)} (threshold ${threshold}${borderline})`;

      if (verdict) return { output: true, status: 'success', reason: summary };

      const failure = {
        output: false,
        status: 'failure',
        reason: summary,
      } satisfies CriterionResult<boolean>;
      if (!options.explainFailures) return failure;

      try {
        const explanation = await explainFailure({
          judge: options.explainFailures,
          prompt: options.prompt,
          conversation,
        });

        return explanation ? { ...failure, reason: `${summary}: ${explanation}` } : failure;
      } catch (error) {
        // The verdict stands; only the explanation is missing.
        return { ...failure, error };
      }
    },
  };
};

async function explainFailure({
  judge,
  prompt,
  conversation,
}: {
  judge: Judge;
  prompt: string;
  conversation: string;
}): Promise<string> {
  const {
    output: { reason },
  } = await judge.invoke({
    messages: [
      {
        role: 'system',
        content: `
    You are a judge.

    The following assertion about a conversation between an AI assistant and a user was evaluated as FALSE.
    Briefly explain why it does not hold, citing the relevant parts of the conversation.

    Assertion:
    <assertion-prompt>
    ${prompt}
    </assertion-prompt>

    Conversation between AI and user:
    <conversation>
    ${conversation}
    </conversation>
    `,
      },
    ],
    schema: explanationSchema,
  });

  return reason.trim();
}

function round(probability: number): number {
  return Math.round(probability * 100) / 100;
}
