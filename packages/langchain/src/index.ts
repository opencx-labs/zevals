import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import {
  AIMessage as LCAIMessage,
  BaseMessage as LCBaseMessage,
  HumanMessage as LCHumanMessage,
  SystemMessage as LCSystemMessage,
  ToolMessage as LCToolMessage,
} from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { Agent, Judge, Message, SyntheticUser, z } from '@zevals/core';

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
  runnable: Runnable<LCBaseMessage[], LCBaseMessage>;
}): SyntheticUser {
  return {
    async respond(params) {
      const lcMessages = params.messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const userResponse = langChainMessageToZEvals(await runnable.invoke(lcMessages));

      if (!userResponse) {
        throw new Error('No result from LangChain');
      }

      return { role: 'user', content: userResponse.content.toString() };
    },
  };
}

export function langChainZEvalsAgent({
  runnable,
}: {
  runnable: Runnable<LCBaseMessage[], LCBaseMessage>;
}): Agent {
  return {
    async invoke({ messages }) {
      const lcMessages = messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const runnableRes = await runnable.invoke(lcMessages);

      const response = langChainMessageToZEvals(runnableRes);

      if (!response) {
        throw new Error(
          `No result from LangChain: ${runnableRes.content.toString()} - ${JSON.stringify(runnableRes)}`,
        );
      }

      return { message: { role: 'assistant', content: response.content.toString() } };
    },
  };
}

export function langChainZEvalsJudge({ model }: { model: BaseChatModel }): Judge {
  return {
    async invoke({ messages, schema }) {
      const lcMessages = messages.flatMap((m) => {
        const message = langChainMessageFromZEvals(m);
        return message ? [message] : [];
      });

      const output = await model
        .withStructuredOutput?.<z.infer<typeof schema>>(schema)
        .invoke(lcMessages);
      if (!output) {
        throw new Error('Given model does not support structured output');
      }

      return { output };
    },
  };
}
