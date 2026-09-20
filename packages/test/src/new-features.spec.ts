import {
  Agent,
  agentResponse,
  aiAssertion,
  aiEval,
  Criterion,
  dynamicMessage,
  evaluate,
  faithfulnessCriterion,
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

  it('asks the judge to reason before it commits to a verdict', async () => {
    // Field order is behaviour, not style: a schema with `verdict` first makes the model
    // emit the boolean before any reasoning, and it was observed returning a verdict that
    // its own `reason` then contradicted.
    let keys: Array<string> = [];

    const judge: Judge = {
      async invoke({ schema }) {
        keys = Object.keys(schema.shape);

        return { output: schema.parse({ verdict: true, reason: null }) };
      },
    };

    await aiAssertion({ judge, prompt: 'The assistant answered' }).evaluate({
      messages: [{ role: 'assistant', content: 'Yes' }],
    });

    expect(keys).toEqual(['reason', 'verdict']);
  });

  it('aiAssertion scope limits what the judge sees', async () => {
    const prompts: Array<string> = [];

    const judge: Judge = {
      async invoke({ messages, schema }) {
        prompts.push(userContent(messages));

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

/** The single user message a judge received; judge prompts put the evaluated data there. */
function userContent(messages: Array<Message>): string {
  const user = messages.filter((m) => m.role === 'user');
  expect(user).toHaveLength(1);
  return String(user[0].content);
}

describe('judge requests', () => {
  const withTools: Array<Message> = [
    { role: 'user', content: 'Cancel order 42' },
    {
      role: 'assistant',
      content: 'Cancelling now',
      tool_calls: [{ name: 'cancel_order', args: { orderId: '42' } }],
    },
    { role: 'tool', name: 'cancel_order', content: { status: 'cancelled' } },
    { role: 'assistant', content: 'Order 42 is cancelled.' },
  ];

  /** Records each judge request and answers with the given outputs, in order. */
  function recordingJudge(outputs: Array<unknown>) {
    const requests: Array<Array<Message>> = [];
    const judge: Judge = {
      async invoke({ messages, schema }) {
        requests.push(messages);
        return { output: schema.parse(outputs[requests.length - 1]) };
      },
    };
    return { judge, requests };
  }

  it('aiAssertion sends instructions as system and the transcript, with tool activity, as user', async () => {
    const { judge, requests } = recordingJudge([{ verdict: true, reason: null }]);

    await aiAssertion({ judge, prompt: 'The order was cancelled' }).evaluate({
      messages: withTools,
    });

    expect(requests[0].map((m) => m.role)).toEqual(['system', 'user']);
    const input = userContent(requests[0]);
    expect(input).toContain('The order was cancelled');
    expect(input).toContain('[tool call] cancel_order({"orderId":"42"})');
    expect(input).toContain('[tool:cancel_order] {"status":"cancelled"}');
    expect(input).not.toContain('[object Object]');
  });

  it('faithfulnessCriterion gives both judge calls a user turn and shows tool results', async () => {
    const { judge, requests } = recordingJudge([
      { claims: ['Order 42 is cancelled'] },
      { results: [{ claim_index: 0, supported: true }] },
    ]);

    const result = await faithfulnessCriterion({ judge }).evaluate({ messages: withTools });

    expect(requests.map((r) => r.map((m) => m.role))).toEqual([
      ['system', 'user'],
      ['system', 'user'],
    ]);
    expect(userContent(requests[0])).toBe('Order 42 is cancelled.');
    const verification = userContent(requests[1]);
    expect(verification).toContain('[tool:cancel_order] {"status":"cancelled"}');
    expect(verification).toContain('[Claim 0] : Order 42 is cancelled');
    expect(verification).not.toContain('[object Object]');
    expect(result.output.results).toEqual([{ claim: 'Order 42 is cancelled', supported: true }]);
  });

  it('explainFailures sends instructions as system and the transcript as user', async () => {
    const { judge, requests } = recordingJudge([{ reason: 'It was never cancelled' }]);

    const result = await aiAssertion({
      prompt: 'The order was cancelled',
      judge: {
        kind: 'jev',
        async probability() {
          return { probability: 0.1 };
        },
      },
      explainFailures: judge,
    }).evaluate({ messages: withTools });

    expect(requests[0].map((m) => m.role)).toEqual(['system', 'user']);
    expect(userContent(requests[0])).toContain('[tool:cancel_order] {"status":"cancelled"}');
    expect(result.reason).toBe('jev p=0.1 (threshold 0.5): It was never cancelled');
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
              tool_calls: [{ name: 'cancel_order', args: { orderId: '42' }, result: 'not_found' }],
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
