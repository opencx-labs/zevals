import { Message, ToolCall } from '../message';
import { Criterion, CriterionResult } from './criterion';

type AssertionResult =
  | boolean
  | Promise<boolean>
  | undefined
  | Promise<undefined>
  | void
  | Promise<void>;

type ToolCallAssertionFn = (
  /** The tool call that was made. */
  toolCall: ToolCall,
) => AssertionResult;

type ToolCallAssertion = {
  /** Assert that the tool with this name was called. */
  name: string;

  /** Arbitrary assertion used to check the tool call's arguments and result. */
  assertion?: ToolCallAssertionFn;
};

type ToolCallsCriterionOutput = {
  toolCallOrderSatisfied: boolean;
};

export function extractToolCallsFromMessages(messages: Array<Message>): Array<ToolCall> {
  return messages.flatMap((message, index) => {
    if (message.role !== 'assistant') return [];

    const calls: Array<ToolCall> = (message.tool_calls ?? [])
      .map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        args: toolCall.args,
      }))
      .concat(
        (message.context?.tool_calls ?? []).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          args: toolCall.args,
          result: toolCall.result,
        })),
      );

    const followingToolResults = messages.slice(index + 1).flatMap((message) => {
      if (!(message.role === 'tool')) return [];
      return [message.content];
    });

    // Set each tool call's result
    calls.forEach((call) => {
      const callResult = followingToolResults.findIndex(
        (result) => result.id === call.id || result.name === call.name,
      );

      if (callResult === -1 && !call.result) return;

      const tool = call.result ?? followingToolResults[callResult];

      call.result = tool;
      delete followingToolResults[callResult];
    });

    return calls;
  });
}

export function aiToolCalls<T>(options: {
  assertion: (toolCalls: Array<ToolCall>) => T | Promise<T>;
}): Criterion<Awaited<T> | undefined> {
  return {
    name: 'AI Tool Calls',

    async evaluate(params): Promise<CriterionResult<Awaited<T> | undefined>> {
      const toolCalls = extractToolCallsFromMessages(params.messages);

      try {
        const assertionRes = await options.assertion(toolCalls);

        return {
          output: assertionRes,
          status: 'success',
        };
      } catch (error) {
        return {
          output: undefined,
          status: 'failure',
          reason: 'Tool call assertion failed',
          error,
        };
      }
    },
  };
}

export const aiToolsCalled: (options: {
  /** Assert that the tool calls are in the same order as in the `toolCalls` array. */
  assertOrder?: boolean;
  /** Tool calls that must be made for this criterion to pass. */
  toolCalls: Array<ToolCallAssertion>;
}) => Criterion<ToolCallsCriterionOutput> = (options) => ({
  name: 'Tools Called',

  async evaluate(params): Promise<CriterionResult<ToolCallsCriterionOutput>> {
    if (options.toolCalls.length === 0) {
      return {
        output: { toolCallOrderSatisfied: true },
        status: 'success',
        reason: 'No tool calls to check',
      };
    }

    // Get tool calls that happened
    const actualToolCalls: Array<ToolCall> = extractToolCallsFromMessages(params.messages);

    // We traverse tool call assertions from last to first
    // This makes writing assertions easier and more intuitive
    const reversedActualToolCalls = actualToolCalls.toReversed();
    const reversedToolCallAssertions = options.toolCalls.toReversed();

    for (let i = 0; i < reversedToolCallAssertions.length; i++) {
      const toolCallAssertion = reversedToolCallAssertions[i];

      if (options.assertOrder) {
        const correspondingActualToolCall = reversedActualToolCalls[i];
        if (!correspondingActualToolCall) {
          return {
            output: { toolCallOrderSatisfied: false },
            status: 'failure',
            reason: `Tool '${toolCallAssertion.name}' was not called`,
          };
        }

        if (correspondingActualToolCall.name !== toolCallAssertion.name) {
          return {
            output: { toolCallOrderSatisfied: false },
            status: 'failure',
            reason: `Tool '${correspondingActualToolCall.name}' was called out of order - expected '${toolCallAssertion.name}'`,
          };
        }
      }

      const actualToolCall = reversedActualToolCalls.find(
        (call) => call.name === toolCallAssertion.name,
      );

      if (!actualToolCall) {
        return {
          output: { toolCallOrderSatisfied: true },
          status: 'failure',
          reason: `Tool '${toolCallAssertion.name}' was not called`,
        };
      }

      if (toolCallAssertion.assertion) {
        try {
          const assertionResult = await toolCallAssertion.assertion(actualToolCall);

          if (typeof assertionResult === 'boolean' && !assertionResult) {
            return {
              output: { toolCallOrderSatisfied: true },
              status: 'failure',
              reason: `Tool '${toolCallAssertion.name}' assertion failed`,
            };
          }
        } catch (error) {
          return {
            output: { toolCallOrderSatisfied: true },
            status: 'failure',
            reason: `Tool '${toolCallAssertion.name}' assertion failed`,
            error,
          };
        }
      }
    }

    return {
      output: { toolCallOrderSatisfied: true },
      status: 'success',
    };
  },
});
