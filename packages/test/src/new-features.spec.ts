import {
  Agent,
  agentResponse,
  aiAssertion,
  aiEval,
  Criterion,
  dynamicMessage,
  evaluate,
  formatTranscript,
  Judge,
  message,
  Message,
  MockCriterion,
  repeat,
  scopeMessages,
  UserMessage,
  userSimulation,
} from '@zevals/core';

function scriptedAgent(responses: Array<string>): Agent {
  const remaining = [...responses];

  return {
    async invoke() {
      const content = remaining.shift();
      if (content === undefined) throw new Error('Scripted agent ran out of responses');

      return { message: { role: 'assistant', content } };
    },
  };
}

describe('dynamicMessage', () => {
  it('computes the user message from the transcript at execution time', async () => {
    const agent = scriptedAgent(['What is your name?', 'Thanks, Jane!']);

    const res = await evaluate({
      agent,
      segments: [
        message({ role: 'user', content: 'Hello' }),
        agentResponse(),
        dynamicMessage(({ messages }) => {
          const lastAssistant = messages.findLast((m) => m.role === 'assistant');

          return {
            role: 'user',
            content: lastAssistant?.content.includes('name') ? 'Jane' : 'I do not understand',
          };
        }),
        agentResponse(),
      ],
    });

    expect(res.messages.map((m) => m.content)).toEqual([
      'Hello',
      'What is your name?',
      'Jane',
      'Thanks, Jane!',
    ]);
  });
});

describe('UserMessage context', () => {
  it('passes user message context through to the agent untouched', async () => {
    const seenContexts: Array<Record<string, unknown> | undefined> = [];

    const agent: Agent = {
      async invoke({ messages }) {
        const lastUser = messages.findLast((m): m is UserMessage => m.role === 'user');
        seenContexts.push(lastUser?.context);

        return { message: { role: 'assistant', content: 'Received' } };
      },
    };

    const attachment = { attachments: [{ url: 'https://example.com/letter.pdf' }] };

    const res = await evaluate({
      agent,
      segments: [
        message({ role: 'user', content: 'Here is the letter', context: attachment }),
        agentResponse(),
      ],
    });

    expect(seenContexts).toEqual([attachment]);
    expect(res.messages[0]).toMatchObject({ role: 'user', context: attachment });
  });

  it('preserves context returned by a synthetic user during simulation', async () => {
    const seenContexts: Array<Record<string, unknown> | undefined> = [];

    const agent: Agent = {
      async invoke({ messages }) {
        const lastUser = messages.findLast((m): m is UserMessage => m.role === 'user');
        seenContexts.push(lastUser?.context);

        return { message: { role: 'assistant', content: 'Got it' } };
      },
    };

    const res = await evaluate({
      agent,
      segments: [
        userSimulation({
          user: {
            async respond() {
              return { role: 'user', content: 'Attaching it now', context: { fileId: 'f1' } };
            },
          },
          until: new MockCriterion({ result: { status: 'success', output: true } }),
        }),
      ],
    });

    expect(seenContexts).toEqual([{ fileId: 'f1' }]);
    expect(res.messages[0]).toMatchObject({ role: 'user', context: { fileId: 'f1' } });
  });
});

describe('userSimulation max exhaustion', () => {
  it('records an explicit failure when max is reached without satisfying until', async () => {
    const until = new MockCriterion<boolean>({
      name: 'Handoff completed',
      result: { status: 'failure', output: false, reason: 'No handoff yet' },
    });

    const res = await evaluate({
      agent: scriptedAgent(['Turn 1', 'Turn 2']),
      segments: [
        userSimulation({
          user: {
            async respond() {
              return { role: 'user', content: 'Please transfer me' };
            },
          },
          until,
          max: 2,
        }),
      ],
    });

    expect(res.success).toBe(false);

    const untilResult = res.getResultOrThrow(until);
    expect(untilResult.status).toBe('failure');
    expect(untilResult.reason).toContain('maximum of 2 turns');
    expect(untilResult.reason).toContain('No handoff yet');
  });
});

describe('criterion scoping', () => {
  const transcript: Array<Message> = [
    { role: 'user', content: 'First question' },
    { role: 'assistant', content: 'First answer' },
    { role: 'user', content: 'Second question' },
    { role: 'tool', name: 'lookup', content: { found: true } },
    { role: 'assistant', content: 'Second answer' },
  ];

  it('scopeMessages selects the last assistant turn', () => {
    const scoped = scopeMessages({ messages: transcript, scope: 'lastAssistantTurn' });

    expect(scoped).toEqual([
      { role: 'tool', name: 'lookup', content: { found: true } },
      { role: 'assistant', content: 'Second answer' },
    ]);

    expect(scopeMessages({ messages: transcript, scope: 'fullTranscript' })).toEqual(transcript);
  });

  it('Criterion.scoped restricts what the wrapped criterion sees', async () => {
    const seen: Array<Array<Message>> = [];

    const capture: Criterion<undefined> = {
      name: 'Capture',
      async evaluate({ messages }) {
        seen.push(messages);
        return { output: undefined, status: 'success' };
      },
    };

    await Criterion.scoped({ criterion: capture, scope: 'lastAssistantTurn' }).evaluate({
      messages: transcript,
    });

    expect(seen[0].map((m) => m.content)).toEqual([{ found: true }, 'Second answer']);
  });

  it('aiAssertion scope limits what the judge sees', async () => {
    const prompts: Array<string> = [];

    const judge: Judge = {
      async invoke({ messages, schema }) {
        prompts.push(messages[0].content as string);

        return { output: schema.parse({ verdict: true, reason: null }) };
      },
    };

    const criterion = aiAssertion({
      judge,
      prompt: 'The assistant answered',
      scope: 'lastAssistantTurn',
    });

    await criterion.evaluate({ messages: transcript });

    expect(prompts[0]).toContain('Second answer');
    expect(prompts[0]).not.toContain('First answer');
  });
});

describe('formatTranscript', () => {
  it('renders messages, tool calls, and criterion verdicts', async () => {
    const criterion = new MockCriterion<boolean>({
      name: 'Order cancelled',
      result: { status: 'failure', output: false, reason: 'The order was never cancelled' },
    });

    const res = await evaluate({
      agent: {
        async invoke() {
          return {
            message: {
              role: 'assistant' as const,
              content: 'Cancelling now',
              tool_calls: [
                { name: 'cancel_order', args: { orderId: '42' }, result: 'not_found' },
              ],
            },
          };
        },
      },
      segments: [
        message({ role: 'user', content: 'Cancel my order' }),
        agentResponse(),
        aiEval(criterion),
      ],
    });

    const transcript = formatTranscript(res);

    expect(transcript).toBe(
      [
        '[user] Cancel my order',
        '[assistant] Cancelling now',
        '  [tool call] cancel_order({"orderId":"42"}) => "not_found"',
        '[eval FAIL] Order cancelled — The order was never cancelled',
      ].join('\n'),
    );
  });
});

describe('repeat', () => {
  it('runs the scenario once per iteration and aggregates results', async () => {
    const res = await repeat({
      count: 3,
      scenario: ({ iteration }) => ({
        agent: scriptedAgent(['Hi']),
        segments: [
          message({ role: 'user', content: `Attempt ${iteration}` }),
          agentResponse(),
          aiEval(
            new MockCriterion({
              result:
                iteration === 1
                  ? { status: 'failure', output: false, reason: 'Flaked' }
                  : { status: 'success', output: true },
            }),
          ),
        ],
      }),
    });

    expect(res.iterations).toHaveLength(3);
    expect(res.success).toBe(false);
    expect(res.failedIterations.map((f) => f.iteration)).toEqual([1]);
    expect(res.iterations[0].messages[0].content).toBe('Attempt 0');
  });
});

describe('judge schema typing', () => {
  it('aiAssertion surfaces the judge reason on success and failure', async () => {
    const judge: Judge = {
      async invoke({ schema }) {
        return { output: schema.parse({ verdict: false, reason: 'Conditional promise only' }) };
      },
    };

    const result = await aiAssertion({ judge, prompt: 'Handoff happened' }).evaluate({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result).toMatchObject({
      status: 'failure',
      output: false,
      reason: 'Conditional promise only',
    });
  });
});
