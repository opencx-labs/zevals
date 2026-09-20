import {
  aiAssertion,
  cloudflareJevClient,
  CriterionScope,
  JevAssertionOptions,
  JevClient,
  Judge,
  Message,
  openRouterJevClient,
  vercelJevClient,
} from '@zevals/core';

type NoulParams = Parameters<JevClient['probability']>[0];

function fakeClient(probability: unknown): JevClient & { calls: Array<NoulParams> } {
  const calls: Array<NoulParams> = [];

  return {
    kind: 'jev',
    calls,
    async probability(params) {
      calls.push(params);
      // Deliberately untyped: lets tests feed malformed answers through the seam.
      return JSON.parse(JSON.stringify({ probability }));
    },
  };
}

function fakeJudge(reason: string): Judge & { calls: number } {
  const judge = {
    calls: 0,
    async invoke({ schema }) {
      judge.calls++;
      return { output: schema.parse({ reason }) };
    },
  } satisfies Judge & { calls: number };

  return judge;
}

const transcript: Array<Message> = [
  { role: 'user', content: 'First question' },
  { role: 'assistant', content: 'First answer' },
  { role: 'user', content: 'Second question' },
  { role: 'tool', name: 'lookup', content: { found: true } },
  { role: 'assistant', content: 'Second answer' },
];

function run({
  client,
  ...options
}: JevAssertionOptions & { client: JevClient; scope?: CriterionScope }) {
  return aiAssertion({ prompt: 'Answered', judge: client, ...options }).evaluate({
    messages: transcript,
  });
}

describe('aiAssertion with a Jev judge', () => {
  it.each([
    { probability: 0.7, status: 'success', output: true },
    { probability: 0.5, status: 'success', output: true },
    { probability: 0.3, status: 'failure', output: false },
  ])('p=$probability against threshold 0.5 → $status', async ({ probability, status, output }) => {
    const result = await run({ client: fakeClient(probability) });

    expect(result).toMatchObject({ status, output });
    expect(result.error).toBeUndefined();
    expect(result.reason).toContain(`jev p=${probability} (threshold 0.5`);
  });

  it('honours a custom threshold', async () => {
    expect(await run({ client: fakeClient(0.7), threshold: 0.8 })).toMatchObject({
      status: 'failure',
      output: false,
      reason: 'jev p=0.7 (threshold 0.8)',
    });
  });

  it('flags borderline probabilities', async () => {
    const result = await run({ client: fakeClient(0.52) });

    expect(result.reason).toBe('jev p=0.52 (threshold 0.5, borderline)');
  });

  it('rejects an out-of-range threshold', () => {
    expect(() => aiAssertion({ prompt: 'x', judge: fakeClient(0.5), threshold: 1.5 })).toThrow(
      RangeError,
    );
  });

  it('sends the prompt, criteria and role-prefixed transcript', async () => {
    const client = fakeClient(0.9);
    const criteria = { true: 'The agent answered', false: 'The agent deflected' };

    await run({ client, criteria });

    expect(client.calls).toEqual([
      {
        instructions: 'Answered',
        criteria,
        state: {
          conversation: [
            '[user] First question',
            '[assistant] First answer',
            '[user] Second question',
            '[tool:lookup] {"found":true}',
            '[assistant] Second answer',
          ].join('\n'),
        },
      },
    ]);
  });

  it('includes assistant tool calls in the transcript', async () => {
    const client = fakeClient(0.9);

    await aiAssertion({ prompt: 'Handed off', judge: client }).evaluate({
      messages: [
        {
          role: 'assistant',
          content: 'Transferring you now',
          tool_calls: [{ name: 'handoff', args: { team: 'billing' } }],
        },
      ],
    });

    expect(client.calls[0].state).toEqual({
      conversation: '[assistant] Transferring you now\n  [tool call] handoff({"team":"billing"})',
    });
  });

  it('honours scope', async () => {
    const client = fakeClient(0.9);

    await run({ client, scope: 'lastAssistantTurn' });

    expect(client.calls[0].state).toEqual({
      conversation: '[tool:lookup] {"found":true}\n[assistant] Second answer',
    });
  });

  it('calls explainFailures only when the assertion fails', async () => {
    const passJudge = fakeJudge('unused');
    const pass = await run({ client: fakeClient(0.9), explainFailures: passJudge });

    expect(pass.status).toBe('success');
    expect(passJudge.calls).toBe(0);

    const failJudge = fakeJudge('The agent never answered the second question');
    const fail = await run({ client: fakeClient(0.1), explainFailures: failJudge });

    expect(failJudge.calls).toBe(1);
    expect(fail).toMatchObject({
      status: 'failure',
      output: false,
      reason: 'jev p=0.1 (threshold 0.5): The agent never answered the second question',
    });
  });

  it('keeps the failing verdict when explainFailures throws', async () => {
    const judge: Judge = {
      async invoke() {
        throw new Error('judge down');
      },
    };

    const result = await run({ client: fakeClient(0.1), explainFailures: judge });

    expect(result).toMatchObject({
      status: 'failure',
      output: false,
      reason: 'jev p=0.1 (threshold 0.5)',
    });
    expect(result.error).toBeInstanceOf(Error);
  });

  it.each([undefined, 'high', 1.2, -0.1, null])(
    'surfaces a malformed probability (%s) as an error, never a pass',
    async (probability) => {
      const result = await run({ client: fakeClient(probability) });

      expect(result).toMatchObject({ status: 'failure', output: false });
      expect(result.error).toBeDefined();
    },
  );

  it('never displays a rounded probability on the wrong side of the threshold', async () => {
    expect((await run({ client: fakeClient(0.499) })).reason).toBe(
      'jev p=0.499 (threshold 0.5, borderline)',
    );
    expect((await run({ client: fakeClient(0.12345) })).reason).toBe('jev p=0.12 (threshold 0.5)');
  });

  it('treats a judge with a probability member but no kind marker as an LLM judge', async () => {
    const judge = {
      probability: 'unrelated',
      async invoke({ schema }) {
        return { output: schema.parse({ verdict: true, reason: 'LLM path' }) };
      },
    } satisfies Judge & { probability: string };

    expect(
      await aiAssertion({ prompt: 'Answered', judge }).evaluate({ messages: transcript }),
    ).toMatchObject({
      status: 'success',
      reason: 'LLM path',
    });
  });

  it('rejects Jev-only options for an LLM judge at compile time', () => {
    const judge = fakeJudge('unused');

    // @ts-expect-error threshold only applies to a Jev judge
    aiAssertion({ prompt: 'x', judge, threshold: 0.8 });
    // @ts-expect-error explainFailures only applies to a Jev judge
    aiAssertion({ prompt: 'x', judge, explainFailures: judge });
  });

  it('surfaces a client rejection as an error', async () => {
    const client: JevClient = {
      kind: 'jev',
      async probability() {
        throw new Error('network down');
      },
    };

    const result = await run({ client });

    expect(result).toMatchObject({ status: 'failure', output: false });
    expect(result.error).toBeInstanceOf(Error);
  });
});

describe('openRouterJevClient', () => {
  function mockedClient(response: Response) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const client = openRouterJevClient({
      apiKey: 'sk-test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response;
      },
    });

    return { calls, client };
  }

  it('posts a noul question to the decisions API and returns the probability', async () => {
    const { calls, client } = mockedClient(
      Response.json({
        answers: { q0: { type: 'noul', noul: 0.13 } },
        usage: { input_tokens: 120, output_tokens: 1, cost: 0.00005 },
        provider: 'TypeSafe',
      }),
    );

    const answer = await client.probability({
      state: { conversation: 'user: hi' },
      instructions: 'The assistant greeted the user',
      criteria: { true: 'A greeting was given' },
    });

    expect(answer).toEqual({ probability: 0.13 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://openrouter.ai/api/alpha/decisions');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.headers).toEqual({
      authorization: 'Bearer sk-test',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'typesafe/jev-1.13',
      state: { conversation: 'user: hi' },
      questions: {
        q0: {
          type: 'noul',
          instructions: 'The assistant greeted the user',
          criteria: { true: 'A greeting was given' },
        },
      },
    });
  });

  it('throws on a non-2xx response', async () => {
    const { client } = mockedClient(new Response('context too long', { status: 400 }));

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      /400 context too long/,
    );
  });

  it('keeps only a bounded, whitespace-collapsed excerpt of an error body', async () => {
    const { client } = mockedClient(
      new Response(`line one\n\n  line two ${'x'.repeat(10_000)}`, { status: 502 }),
    );

    const error = await client
      .probability({ state: {}, instructions: 'x' })
      .catch((e: unknown) => e);
    const message = error instanceof Error ? error.message : '';

    expect(message).toMatch(/^OpenRouter decisions request failed: 502 line one line two x+…$/);
    expect(message.length).toBeLessThan(600);
  });

  it('keeps the HTTP status when the error body stream fails', async () => {
    const body = new ReadableStream({
      pull(controller) {
        controller.error(new Error('socket hang up'));
      },
    });
    const { client } = mockedClient(new Response(body, { status: 503 }));

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      /^OpenRouter decisions request failed: 503/,
    );
  });

  it('throws on a malformed response body', async () => {
    const { client } = mockedClient(
      Response.json({ answers: { q0: { type: 'noul', probability: 0.4 } } }),
    );

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow();
  });

  it('surfaces an OpenRouter failure as a criterion error', async () => {
    const { client } = mockedClient(new Response('boom', { status: 500 }));

    const result = await run({ client });

    expect(result).toMatchObject({ status: 'failure', output: false });
    expect(String(result.error)).toContain('500');
  });
});

describe('vercelJevClient', () => {
  function mockedClient(response: Response, options: Parameters<typeof vercelJevClient>[0] = {}) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const client = vercelJevClient({
      apiKey: 'vck-test',
      ...options,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response;
      },
    });

    return { calls, client };
  }

  it('posts a boolean question to /v1/evaluate and returns the probability', async () => {
    const { calls, client } = mockedClient(
      Response.json({
        model: 'typesafe-ai/jev',
        answers: { q0: { type: 'boolean', probability: 0.98 } },
        usage: { inputTokens: 275, outputTokens: 20 },
        providerMetadata: { gateway: { cost: '0.00001155' } },
      }),
    );

    const answer = await client.probability({
      state: { conversation: 'user: hi' },
      instructions: 'The assistant greeted the user',
      criteria: { true: 'A greeting was given' },
    });

    expect(answer).toEqual({ probability: 0.98 });
    expect(calls[0].url).toBe('https://ai-gateway.vercel.sh/v1/evaluate');
    expect(calls[0].init?.headers).toEqual({
      authorization: 'Bearer vck-test',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'typesafe-ai/jev',
      state: { conversation: 'user: hi' },
      questions: {
        q0: {
          type: 'boolean',
          instructions: 'The assistant greeted the user',
          criteria: { true: 'A greeting was given' },
        },
      },
    });
  });

  it('honours a custom model and base URL', async () => {
    const { calls, client } = mockedClient(
      Response.json({ answers: { q0: { type: 'boolean', probability: 0.5 } } }),
      { model: 'typesafe-ai/jev-1.13', baseUrl: 'https://gateway.example.com' },
    );

    await client.probability({ state: {}, instructions: 'x' });

    expect(calls[0].url).toBe('https://gateway.example.com/v1/evaluate');
    expect(JSON.parse(String(calls[0].init?.body)).model).toBe('typesafe-ai/jev-1.13');
  });

  it('throws on a non-2xx response', async () => {
    const { client } = mockedClient(new Response('context too long', { status: 400 }));

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      /^Vercel AI Gateway evaluate request failed: 400 context too long$/,
    );
  });

  it('rejects a noul-shaped answer, which this endpoint never returns', async () => {
    const { client } = mockedClient(
      Response.json({ answers: { q0: { type: 'noul', noul: 0.4 } } }),
    );

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow();
  });

  it('reports a missing API key without calling fetch', async () => {
    const client = vercelJevClient({
      fetch: () => Promise.reject(new Error('should not be called')),
    });

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      'Vercel AI Gateway API key missing: pass apiKey or set AI_GATEWAY_API_KEY',
    );
  });
});

describe('cloudflareJevClient', () => {
  function mockedClient(
    response: Response,
    options: Parameters<typeof cloudflareJevClient>[0] = {},
  ) {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];

    const client = cloudflareJevClient({
      accountId: 'acct-test',
      apiToken: 'cf-test',
      ...options,
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return response;
      },
    });

    return { calls, client };
  }

  it('posts a noul question nested under input and returns the probability', async () => {
    const { calls, client } = mockedClient(
      Response.json({
        result: {
          model: 'jev-1.13.0',
          answers: { q0: { type: 'noul', noul: 0.95 } },
          usage: { input_tokens: 426, output_tokens: 73 },
        },
        success: true,
        errors: [],
      }),
    );

    const answer = await client.probability({
      state: { conversation: 'user: hi' },
      instructions: 'The assistant greeted the user',
      criteria: { true: 'A greeting was given' },
    });

    expect(answer).toEqual({ probability: 0.95 });
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/accounts/acct-test/ai/run');
    expect(calls[0].init?.headers).toEqual({
      authorization: 'Bearer cf-test',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      model: 'typesafe/jev',
      input: {
        state: { conversation: 'user: hi' },
        questions: {
          q0: {
            type: 'noul',
            instructions: 'The assistant greeted the user',
            criteria: { true: 'A greeting was given' },
          },
        },
      },
    });
  });

  it('also reads an answer that is not wrapped in the /client/v4 envelope', async () => {
    const { client } = mockedClient(
      Response.json({ answers: { q0: { type: 'noul', noul: 0.12 } } }),
    );

    expect(await client.probability({ state: {}, instructions: 'x' })).toEqual({
      probability: 0.12,
    });
  });

  it('throws on a non-2xx response', async () => {
    const { client } = mockedClient(new Response('{"errors":[{"code":7003}]}', { status: 404 }));

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      /^Cloudflare Workers AI run request failed: 404 /,
    );
  });

  it('reports a missing account id before a missing token', async () => {
    const client = cloudflareJevClient({
      apiToken: 'cf-test',
      fetch: () => Promise.reject(new Error('should not be called')),
    });

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      'Cloudflare account id missing: pass accountId or set CLOUDFLARE_ACCOUNT_ID',
    );
  });

  it('reports a missing API token', async () => {
    const client = cloudflareJevClient({
      accountId: 'acct-test',
      fetch: () => Promise.reject(new Error('should not be called')),
    });

    await expect(client.probability({ state: {}, instructions: 'x' })).rejects.toThrow(
      'Cloudflare API token missing: pass apiToken or set CLOUDFLARE_API_TOKEN',
    );
  });
});

describe('every bundled Jev client', () => {
  it('works as an aiAssertion judge, whatever the wire shape', async () => {
    const clients = [
      openRouterJevClient({
        apiKey: 'k',
        fetch: async () => Response.json({ answers: { q0: { type: 'noul', noul: 0.9 } } }),
      }),
      vercelJevClient({
        apiKey: 'k',
        fetch: async () =>
          Response.json({ answers: { q0: { type: 'boolean', probability: 0.9 } } }),
      }),
      cloudflareJevClient({
        accountId: 'a',
        apiToken: 'k',
        fetch: async () =>
          Response.json({ result: { answers: { q0: { type: 'noul', noul: 0.9 } } } }),
      }),
    ];

    for (const client of clients) {
      expect(await run({ client })).toMatchObject({
        status: 'success',
        output: true,
        reason: 'jev p=0.9 (threshold 0.5)',
      });
    }
  });
});
