import { BaseMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { ChatOpenAI } from '@langchain/openai';
import zevals from '@zevals/core';
import { langChainZEvalsJudge, langChainZEvalsSyntheticUser } from '@zevals/langchain';
import { simpleExampleAgent } from './simple-example-agent.js';

test('User simulation example', { timeout: 60000 }, async () => {
  const agent = simpleExampleAgent();
  const model = new ChatOpenAI({ model: 'gpt-4.1-mini', temperature: 0 });
  const judge = langChainZEvalsJudge({ model });

  const user = langChainZEvalsSyntheticUser({
    runnable: RunnableLambda.from((messages: BaseMessage[]) =>
      model.invoke([
        {
          role: 'system',
          content: `You will ask three questions, each in a separate message. Do not repeat the same question.
             Question 1) What is the capital of France? 
             Question 2) What is the capital of Germany? 
             Question 3) What is the capital of Italy?`,
        },
        ...messages,
      ]),
    ),
  });

  const { messages, success } = await zevals.evaluate({
    agent,
    segments: [
      zevals.userSimulation({
        user,
        until: zevals.aiAssertion({
          judge,
          prompt: 'The assistant has answered THREE questions',
        }),
      }),
    ],
  });

  expect(success).toBe(true);
  expect(messages.length).toBe(6);
});
