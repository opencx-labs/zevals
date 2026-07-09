import { z, ZodObject, ZodRawShape } from 'zod';
import { Agent } from './agent';
import { Criterion, CriterionResult } from './criteria/criterion';
import { Message, ToolCall } from './message';
import { Segment, SegmentEvaluationPromise } from './segment';
import { groupBy } from './utils';

export type EvaluatedSegment =
  | { type: 'message'; message: Message }
  | {
      type: 'eval';
      evalResult: CriterionResult<any>;
      criterion: Criterion<any>;
    };

/** An AI to be used for extracting structured output from the conversation. */
export interface Judge {
  invoke<Shape extends ZodRawShape, T extends ZodObject<Shape>>(params: {
    messages: Array<Message>;
    schema: T;
  }): Promise<{ output: z.infer<T> }>;
}

export type EvaluationParams<A extends Agent> = {
  agent: A | (() => Promise<A>);
  /** The {@link Segment}s to evaluate the agent against. */
  segments: Array<Segment<A>>;
};

/**
 * Evaluates the scenario (`segments`) against the agent.
 */
export async function evaluate<A extends Agent>({ agent, segments }: EvaluationParams<A>) {
  // Initialize the agent
  const _agent = typeof agent === 'function' ? await agent() : agent;

  const evaluatedSegmentPromises: Array<SegmentEvaluationPromise> = [];

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];

    const previousActualMessages = evaluatedSegmentPromises.flatMap((m) =>
      m.type === 'message' ? [m.message] : [],
    );

    const segmentResult = await segment.evaluate({ agent: _agent, previousActualMessages });

    evaluatedSegmentPromises.push(...segmentResult);
  }

  const results: EvaluatedSegment[] = await Promise.all(
    evaluatedSegmentPromises.map((res) => {
      if (res.type === 'eval') {
        return res.evalResult.then((evalResult) => ({
          type: 'eval' as const,
          evalResult,
          criterion: res.criterion,
        }));
      } else {
        return res;
      }
    }),
  );

  const getResult = <T>(criterion: Criterion<T>): CriterionResult<T> | undefined => {
    const res = results.find((r) => r.type === 'eval' && r.criterion === criterion);

    return (res as { evalResult: CriterionResult<T> } | undefined)?.evalResult;
  };

  const resultsByStatus = groupBy(
    results.flatMap((r) => (r.type === 'eval' && r.evalResult.status ? [r] : [])),
    (r) => r.evalResult.status ?? ('unknown' as const),
  );

  return {
    /** Evaluation history, including messages and eval results. */
    results,
    /** Evaluation results grouped by status. */
    resultsByStatus,
    /** Resulting messages. */
    messages: evaluatedSegmentPromises.flatMap((m) => (m.type === 'message' ? [m.message] : [])),

    /** True if no evals failed. */
    success: resultsByStatus.failure.length === 0,

    /**
     * Get all evaluation results for this particular criterion instance (using reference equality).
     */
    getResults: <T>(criterion: Criterion<T>): CriterionResult<T>[] => {
      return results.flatMap((r) =>
        r.type === 'eval' && r.criterion === criterion ? [r.evalResult] : [],
      );
    },

    /**
     * Gets the first result of a given criterion instance (using reference equality).
     */
    getResult,

    /**
     * Gets the first result of a given criterion instance (using reference equality)
     * @throws if the criterion is not found.
     * **Note**: Use `getResults` as a safer alternative.
     *
     * **Note**: Lookup uses reference equality on the criterion *instance*. If you build
     * criteria inside loops or helper functions, keep a reference to the exact instance
     * you passed to the segment — an identical-looking criterion built twice will not match.
     */
    getResultOrThrow: <T>(criterion: Criterion<T>): CriterionResult<T> => {
      const res = getResult(criterion);

      if (!res) {
        throw new Error(`Cannot find results for criterion ${criterion.name}`);
      }

      return res;
    },
  };
}

export type EvaluationResult<A extends Agent = Agent> = Awaited<ReturnType<typeof evaluate<A>>>;

/**
 * Runs a scenario `count` times, e.g. to require that hard assertions hold repeatedly
 * rather than on average.
 *
 * The `scenario` factory is called once per iteration, so each run can build a fresh
 * agent, session, and criterion instances.
 */
export async function repeat<A extends Agent>({
  count,
  scenario,
}: {
  count: number;
  scenario: (params: {
    /** Zero-based index of the current iteration. */
    iteration: number;
  }) => EvaluationParams<A> | Promise<EvaluationParams<A>>;
}) {
  const iterations: Array<EvaluationResult<A>> = [];

  for (let iteration = 0; iteration < count; iteration++) {
    iterations.push(await evaluate(await scenario({ iteration })));
  }

  return {
    /** The result of each iteration, in order. */
    iterations,
    /** True only if every iteration succeeded. */
    success: iterations.every((iteration) => iteration.success),
    /** The iterations that had at least one failed eval. */
    failedIterations: iterations.flatMap((result, iteration) =>
      result.success ? [] : [{ iteration, result }],
    ),
  };
}

function formatToolCall(toolCall: ToolCall): string {
  const result = toolCall.result === undefined ? '' : ` => ${JSON.stringify(toolCall.result)}`;

  return `${toolCall.name}(${JSON.stringify(toolCall.args)})${result}`;
}

/**
 * Formats an evaluation history (messages, tool calls, and criterion verdicts with
 * reasons) into a readable transcript — handy for failure messages in tests.
 *
 * Accepts the object returned by {@link evaluate}, or anything with a `results` array.
 */
export function formatTranscript({ results }: { results: Array<EvaluatedSegment> }): string {
  const lines = results.flatMap((segment) => {
    if (segment.type === 'message') {
      const message = segment.message;

      if (message.role === 'tool') {
        return [`[tool:${message.name}] ${JSON.stringify(message.content)}`];
      }

      const toolCalls =
        message.role === 'assistant'
          ? [...(message.tool_calls ?? []), ...(message.context?.tool_calls ?? [])].map(
              (toolCall) => `  [tool call] ${formatToolCall(toolCall)}`,
            )
          : [];

      return [`[${message.role}] ${message.content}`, ...toolCalls];
    }

    const { evalResult, criterion } = segment;
    const status =
      evalResult.status === 'success' ? 'PASS' : evalResult.status === 'failure' ? 'FAIL' : '????';
    const reason = evalResult.reason ? ` — ${evalResult.reason}` : '';
    const error = evalResult.error ? ` (error: ${String(evalResult.error)})` : '';

    return [`[eval ${status}] ${criterion.name}${reason}${error}`];
  });

  return lines.join('\n');
}
