<div align="center">
<img src="./static/zevals-logo-wide.png" alt="Zevals Logo" height="200" />
</div>

# Zevals

Simple, practical AI evaluations in TypeScript.

Zevals provides utilities for testing AI agents. Unlike the few existing AI eval libraries and frameworks:

- Treats AI evals like end-to-end tests, with less focus on metrics and more focus on binary assertions
- Designed to evaluate full conversations, not just single query/response pairs
- Does not impose any testing framework or test runner

# Example

```typescript
import { ChatOpenAI } from '@langchain/openai';
import zevals from '@zevals/core';
import { langChainZEvalsJudge } from '@zevals/langchain';

test('Simple example', async () => {
  const agent: zevals.Agent = {
    async invoke(messages) {
      // Run your application logic to generate a response for the user
      return { response: { role: 'assistant', content: 'What kind of vitamin?' } };
    },
  };

  const judge = langChainZEvalsJudge({
    model: new ChatOpenAI({
      modelName: 'gpt-4.1-mini',
      temperature: 0,
    }),
  });

  const followupAssertion = zevals.aiAssertion({
    judge,
    prompt: 'The assistant asked a followup question',
  });

  const { getResultOrThrow } = await zevals.evaluate({
    agent,
    segments: [
      // The user wants vitamins
      zevals.message({ role: 'user', content: 'I want another bottle of the vitamin' }),

      // The agent responds
      zevals.agentResponse(),

      // We judge the above
      zevals.aiEval(followupAssertion),
    ],
  });

  // Run your assertions on type-safe outputs
  expect(getResultOrThrow(followupAssertion).output).toBe(true);
});
```

> [!NOTE]
> You can find more examples in the [examples directory](./packages/test/src/examples/).

# Installation

```sh
npm install @zevals/core

# To use with LangChain models
# (feel free to use anything other than OpenAI)
npm install @langchain/core @langchain/openai @zevals/langchain

# To use Vercel AI SDK model providers
npm install ai @zevals/vercel

# To use autoevals scorers
npm install autoevals @zevals/autoevals
```

# Features

- Support for evaluating entire scenarios, with optional user simulation
- Utilities for LLM-as-a-judge, and more programmatic assertion functions for tool calling
- Utilities for wrapping your existing user message-handling logic into an agent that can be easily tested
- Very simple, extensible design, with no assumptions about how you will use the library
- Facilities for benchmarking using popular benchmarks like tau-bench
- (Optionally) integrates with any LLM provider via LangChain or Vercel AI SDK
- (Optionally) integrates with Braintrust's autoevals scorers
- As type-safe as practically possible

## Assertions

Zevals provides a few ways to assert that your agent did what it was supposed to do. Most notably, you can run assertions on the tool calls made by your agents:

```typescript
import zevals from '@zevals/core';
import { simpleExampleAgent } from './simple-example-agent.js';

test('Tool calls example', { timeout: 20000 }, async () => {
  const agent = simpleExampleAgent();

  // We expect the `get_current_date` tool to be called and to return the current date
  const dateToolCalledAssertion = zevals.aiToolCalls({
    assertion(toolCalls) {
      const date = new Date();

      expect(toolCalls).toEqual(
        expect.arrayContaining([
          {
            name: 'get_current_date',
            args: {},
            result: {
              day: date.getDate(),
              month: date.getMonth(),
              year: date.getFullYear(),
            },
          },
        ]),
      );
    },
  });

  const { getResultOrThrow } = await zevals.evaluate({
    agent,
    segments: [
      zevals.message({ role: 'user', content: 'What day of month are we at?' }),

      zevals.agentResponse(),

      zevals.aiEval(dateToolCalledAssertion),
    ],
  });

  const error = getResultOrThrow(dateToolCalledAssertion).error;
  if (error) throw error;
});
```

> [!NOTE]
> You can very easily create new types of assertions. See the [`Criterion` interface](./packages/core/src/criteria/criterion.ts).

## User Simulation

You can simulate a human user by specifying a prompt for the user, and a condition to signal the end of the simulation.

```typescript
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
```

> [!NOTE]
> A `userSimulation` is a type of [Segment](./packages/core/src/segment.ts). You can very easily create new types of segments by implementing the interface.

If the simulation reaches `max` turns without the `until` criterion passing, zevals records an explicit failed result for the criterion (with a reason indicating the ceiling was hit), so an exhausted simulation is never silent.

## Deterministic Adaptive Turns

Scripted `message(...)` sequences are rigid, and `userSimulation` costs an LLM call per turn. When you just need to respond to whatever the agent asked — deterministically and for free — use `dynamicMessage`, which computes the next message from the transcript at execution time:

```typescript
zevals.dynamicMessage(({ messages }) => {
  const lastAssistant = messages.findLast((m) => m.role === 'assistant');

  return {
    role: 'user',
    content: lastAssistant?.content.includes('name') ? 'Jane Doe' : 'MG-12345678',
  };
}),
zevals.agentResponse(),
```

## Message Context (Attachments, Metadata)

User messages can carry an opaque `context` object — attachments, channel metadata, pre-chat data, anything. Zevals passes it through untouched to `Agent.invoke` and never sends it to judges:

```typescript
zevals.message({
  role: 'user',
  content: 'I have attached the letter',
  context: { attachments: [{ url: 'https://example.com/letter.pdf' }] },
});
```

A `SyntheticUser` can also return `context` on its messages; `userSimulation` preserves it.

## Scoping Assertions

By default, criteria see the full transcript. To judge only the agent's latest turn (everything after the last user message), pass `scope` to `aiAssertion`, or wrap any criterion with `Criterion.scoped`:

```typescript
zevals.aiAssertion({ judge, prompt: 'The agent transferred the chat', scope: 'lastAssistantTurn' });

zevals.Criterion.scoped({ criterion: myCriterion, scope: 'lastAssistantTurn' });
```

For conditions that should not rely on a judge at all (e.g. "the handoff tool was actually called"), remember that `until` accepts any `Criterion` — including `aiToolsCalled` / `aiToolCalls` — and criteria compose with `Criterion.and` / `Criterion.negate`.

## Repeated Runs

Hard assertions should hold repeatedly, not on average. `repeat` runs a scenario `count` times, building a fresh agent/segments per iteration through the `scenario` factory:

```typescript
const { success, iterations, failedIterations } = await zevals.repeat({
  count: 5,
  scenario: async () => ({
    agent: await makeFreshAgent(),
    segments: [
      /* ... */
    ],
  }),
});

expect(success).toBe(true); // All 5 iterations must pass
```

## Readable Failure Output

`formatTranscript` renders an evaluation result (messages, tool calls, and criterion verdicts with the judge's reasoning) as a readable string — useful in test failure messages:

```typescript
const res = await zevals.evaluate({ agent, segments });

expect(res.success, zevals.formatTranscript(res)).toBe(true);
// [user] Cancel my order
// [assistant] Cancelling now
//   [tool call] cancel_order({"orderId":"42"}) => "not_found"
// [eval FAIL] Order cancelled — The order was never cancelled
```

## Integration with LLM Providers

As we've seen in the examples above, you can use any LangChain model as judge, agent, or synthetic user by using functions from `@zevals/langchain`. Similarly, you can use the `@zevals/vercel` package to utilize any provider from the Vercel AI SDK:

```typescript
import { openai } from '@ai-sdk/openai';
import zevals from '@zevals/core';
import { vercelZEvalsAgent, vercelZEvalsJudge } from '@zevals/vercel';
import { generateText } from 'ai';

test('Vercel AI SDK integration', { timeout: 10000 }, async () => {
  const model = openai.chat('gpt-4.1-mini');

  const agent = vercelZEvalsAgent({
    runnable({ messages }) {
      // Put any agent logic here
      return generateText({ model, messages });
    },
  });

  const judge = vercelZEvalsJudge({ model });

  const { messages, success } = await zevals.evaluate({
    agent,
    segments: [
      zevals.message({ role: 'user', content: 'Hello' }),

      zevals.agentResponse(),

      zevals.aiEval(zevals.aiAssertion({ judge, prompt: 'The assistant greeted the user' })),
    ],
  });

  expect(success).toBe(true);
  expect(messages).toHaveLength(2);
});
```

# License

[MIT](./LICENSE)
