import type { JSONSchema7 } from '@ai-sdk/provider';
import { Agent, Judge, Message, SyntheticUser, z } from '@zevals/core';
import {
  CoreMessage,
  generateObject,
  jsonSchema,
  LanguageModelV1,
  ToolCallUnion,
  ToolSet,
} from 'ai';

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
      // `schema` is a zod 4 schema (the zod @zevals/core ships). AI SDK 4 can only convert
      // zod 3 schemas itself, so pass JSON Schema (draft-07, the dialect AI SDK 4 emits) and
      // validate the answer with zod here.
      const { object } = await generateObject({
        model,
        schema: jsonSchema<z.infer<typeof schema>>(
          // zod's payload type is its own JSON Schema type; the value is plain draft-07 JSON Schema.
          z.toJSONSchema(schema, { target: 'draft-7' }) as JSONSchema7,
          {
            validate(value) {
              const result = schema.safeParse(value);
              return result.success
                ? { success: true, value: result.data }
                : { success: false, error: result.error };
            },
          },
        ),
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
