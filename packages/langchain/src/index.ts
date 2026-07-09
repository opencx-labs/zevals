import {
  AIMessage as LCAIMessage,
  BaseMessage as LCBaseMessage,
  HumanMessage as LCHumanMessage,
  SystemMessage as LCSystemMessage,
  ToolMessage as LCToolMessage,
} from '@langchain/core/messages';
import { Agent, Judge, Message, SyntheticUser, z } from '@zevals/core';

/**
 * Minimal structural interface for a LangChain runnable that maps messages to a message.
 *
 * Intentionally loose so that runnables/models from any `@langchain/core` version are
 * accepted without casts, even when the installed version differs from the one zevals
 * was built against.
 */
export interface LangChainMessagesRunnableLike {
  invoke(
    messages: unknown,
    options?: unknown,
  ): Promise<{
    content: { toString(): string };
    tool_calls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
  }>;
}

/**
 * Minimal structural interface for a LangChain chat model that supports structured output.
 * See {@link LangChainMessagesRunnableLike} for why this is not typed as `BaseChatModel`.
 */
export interface LangChainStructuredOutputModelLike {
  withStructuredOutput?(
    schema: unknown,
    config?: unknown,
  ): { invoke(messages: unknown, options?: unknown): Promise<unknown> };
}

export function langChainMessageToZEvals(message: LCBaseMessage): Message | undefined {
  if (message.getType() === 'system') {
    return {
      role: 'system',
      content: message.content.toString(),
    };
  }
  if (message.getType() === 'ai') {
    const aiMessage = message as LCAIMessage;
    return {
      role: 'assistant',
      content: message.content.toString(),
      tool_calls: aiMessage.tool_calls?.map((tc) => ({ id: tc.id, name: tc.name, args: tc.args })),
    };
  } else if (message.getType() === 'human') {
    return {
      role: 'user',
      content: message.content.toString(),
    };
  } else if (message.getType() === 'tool') {
    const m = message as LCToolMessage;
    return {
      role: 'tool',
      name: m.name ?? '_unknown_',
      tool_call_id: m.tool_call_id,
      content: JSON.parse(m.content.toString()),
    };
  }
}

export function langChainMessagesToZEvals(messages: LCBaseMessage[]): Message[] {
  return messages.flatMap((m) => {
    const zevalsMessage = langChainMessageToZEvals(m);
    return zevalsMessage ? [zevalsMessage] : [];
  });
}

export function langChainMessageFromZEvals(messages: Message): LCBaseMessage | undefined {
  if (messages.role === 'system') {
    return new LCSystemMessage(messages.content);
  } else if (messages.role === 'user') {
    return new LCHumanMessage(messages.content);
  } else if (messages.role === 'assistant') {
    return new LCAIMessage(messages.content);
  } else if (messages.role === 'tool') {
    return new LCToolMessage({
      tool_call_id: messages.tool_call_id ?? crypto.randomUUID(),
      name: messages.name,
      content: JSON.stringify(messages.content),
    });
  }
}

export function langChainMessagesFromZEvals(messages: Message[]): LCBaseMessage[] {
  return messages.flatMap((m) => {
    const lcMessage = langChainMessageFromZEvals(m);
    return lcMessage ? [lcMessage] : [];
  });
}

export function langChainZEvalsSyntheticUser({
  runnable,
}: {
  runnable: LangChainMessagesRunnableLike;
}): SyntheticUser {
  return {
    async respond(params) {
      const lcMessages = params.messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const userResponse = await runnable.invoke(lcMessages);

      return { role: 'user', content: userResponse.content.toString() };
    },
  };
}

export function langChainZEvalsAgent({
  runnable,
}: {
  runnable: LangChainMessagesRunnableLike;
}): Agent {
  return {
    async invoke({ messages }) {
      const lcMessages = messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const response = await runnable.invoke(lcMessages);

      return {
        message: {
          role: 'assistant',
          content: response.content.toString(),
          tool_calls: response.tool_calls?.map((tc) => ({
            id: tc.id,
            name: tc.name,
            args: tc.args,
          })),
        },
      };
    },
  };
}

export function langChainZEvalsJudge({
  model,
}: {
  model: LangChainStructuredOutputModelLike;
}): Judge {
  return {
    async invoke({ messages, schema }) {
      const lcMessages = messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const structuredModel = model.withStructuredOutput?.(schema);
      if (!structuredModel) {
        throw new Error('Given model does not support structured output');
      }

      const output = (await structuredModel.invoke(lcMessages)) as z.infer<typeof schema>;

      return { output };
    },
  };
}
