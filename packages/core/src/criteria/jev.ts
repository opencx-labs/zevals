import { z } from 'zod';
import { formatMessage, Judge } from '../eval-runner';
import { Message } from '../message';
import { CriterionResult } from './criterion';

/**
 * Minimal client for TypeSafe's Jev model. Answers a single `noul` question: the
 * calibrated probability that `instructions` holds for `state`.
 *
 * Pass one as {@link aiAssertion}'s `judge`. Implement it over any transport;
 * {@link openRouterJevClient} is provided for OpenRouter.
 */
export interface JevClient {
  /** Marks this as a Jev client, so {@link aiAssertion} can tell it apart from an LLM judge. */
  readonly kind: 'jev';
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

/** Options that only apply when {@link aiAssertion}'s judge is a {@link JevClient}. */
export type JevAssertionOptions = {
  /** The assertion passes when Jev's probability is at or above this. Defaults to `0.5`. */
  threshold?: number;
  /** Optional descriptions of what makes the assertion true / false. */
  criteria?: { true?: string; false?: string };
  /** On a failing verdict only, ask this LLM judge to explain the failure. */
  explainFailures?: Judge;
};

/** Distinguishes a {@link JevClient} from an LLM {@link Judge}. */
export function isJevClient(judge: Judge | JevClient): judge is JevClient {
  return 'kind' in judge && judge.kind === 'jev';
}

export function jevThreshold(options: JevAssertionOptions): number {
  const threshold = options.threshold ?? 0.5;

  if (!(threshold >= 0 && threshold <= 1)) {
    throw new RangeError(`aiAssertion threshold must be between 0 and 1, got ${threshold}`);
  }

  return threshold;
}

/**
 * Decides an assertion with Jev: a calibrated probability compared against `threshold`,
 * with no generated text. `reason` always carries the probability.
 */
export async function evaluateWithJev({
  client,
  prompt,
  messages,
  threshold,
  criteria,
  explainFailures,
}: Omit<JevAssertionOptions, 'threshold'> & {
  client: JevClient;
  prompt: string;
  messages: Array<Message>;
  threshold: number;
}): Promise<CriterionResult<boolean>> {
  const conversation = messages.flatMap(formatMessage).join('\n');

  let probability: number;
  try {
    const answer = await client.noul({
      state: { conversation },
      instructions: prompt,
      ...(criteria ? { criteria } : {}),
    });
    probability = jevAnswerSchema.parse(answer).probability;
  } catch (error) {
    return { output: false, status: 'failure', reason: 'jev call failed', error };
  }

  const borderline = Math.abs(probability - threshold) < BORDERLINE_MARGIN ? ', borderline' : '';
  const summary = `jev p=${formatProbability(probability, threshold)} (threshold ${threshold}${borderline})`;

  if (probability >= threshold) return { output: true, status: 'success', reason: summary };

  const failure = {
    output: false,
    status: 'failure',
    reason: summary,
  } satisfies CriterionResult<boolean>;
  if (!explainFailures) return failure;

  try {
    const explanation = await explainFailure({ judge: explainFailures, prompt, conversation });

    return explanation ? { ...failure, reason: `${summary}: ${explanation}` } : failure;
  } catch (error) {
    // The verdict stands; only the explanation is missing.
    return { ...failure, error };
  }
}

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

/**
 * Rounds to 2 decimals, adding more when rounding would put the displayed value on the other
 * side of the threshold (e.g. a failing 0.499 is shown as 0.499, not 0.5).
 */
function formatProbability(probability: number, threshold: number): number {
  const passes = probability >= threshold;

  for (let decimals = 2; decimals <= 6; decimals++) {
    const rounded = Math.round(probability * 10 ** decimals) / 10 ** decimals;
    if (rounded >= threshold === passes) return rounded;
  }

  return probability;
}
