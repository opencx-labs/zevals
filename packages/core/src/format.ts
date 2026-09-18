import { Message, ToolCall } from './message';

function formatToolCall(toolCall: ToolCall): string {
  const result = toolCall.result === undefined ? '' : ` => ${JSON.stringify(toolCall.result)}`;

  return `${toolCall.name}(${JSON.stringify(toolCall.args)})${result}`;
}

/**
 * Formats a message (and an assistant's tool calls) as `[role] content` lines.
 *
 * Shared by `formatTranscript` (display) and the Jev judge (model input): changing the
 * format changes what Jev scores.
 */
export function formatMessage(message: Message): Array<string> {
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
