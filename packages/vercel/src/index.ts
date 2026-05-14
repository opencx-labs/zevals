import { Agent, Judge, Message, SyntheticUser, z } from '@zevals/core';
import { CoreMessage, generateObject, LanguageModelV1, ToolCallUnion, ToolSet } from 'ai';

export function vercelCoreMessageFromZEvalsMessage(message: Message): CoreMessage {
  if (message.role === 'system' || message.role === 'user' || message.role === 'assistant') {
    return message;
  }

  return {
    role: 'tool',
    content: [
      {
        result: message.content,
        toolCallId: message.tool_call_id ?? '',
        toolName: message.name,
        type: 'tool-result',
      },
    ],
  };
}

export function vercelZEvalsJudge({ model }: { model: LanguageModelV1 }): Judge {
  return {
    async invoke(params) {
      const messages = params.messages.map(vercelCoreMessageFromZEvalsMessage);
      const schema = params.schema;
      const { object } = await generateObject<z.infer<typeof schema>>({
        model,
        schema,
        messages,
      });

      return { output: object };
    },
  };
}

export function vercelZEvalsSyntheticUser({
  runnable,
}: {
  runnable: (params: { messages: Array<CoreMessage> }) => Promise<{ text: string }>;
}): SyntheticUser {
  return {
    async respond(params) {
      const messages = params.messages.map(vercelCoreMessageFromZEvalsMessage);
      const { text } = await runnable({ messages });

      return {
        role: 'user',
        content: text,
      };
    },
  };
}

export function vercelZEvalsAgent({
  runnable,
}: {
  runnable: (params: {
    messages: Array<CoreMessage>;
  }) => Promise<{ text: string; toolCalls?: Array<ToolCallUnion<ToolSet>> }>;
}): Agent {
  return {
    async invoke(params) {
      const messages = params.messages.map(vercelCoreMessageFromZEvalsMessage);
      const { text, toolCalls } = await runnable({ messages });

      return {
        message: {
          role: 'assistant',
          content: text,
          tool_calls: toolCalls?.map((tc) => ({
            args: tc.args,
            name: tc.toolName,
            id: tc.toolCallId,
          })),
        },
      };
    },
  };
}
