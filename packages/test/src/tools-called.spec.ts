import { aiToolsCalled, Message, ToolCall } from '@zevals/core';

function lookups(...orderIds: Array<string>): Array<Message> {
  return [
    {
      role: 'assistant',
      content: '',
      tool_calls: orderIds.map((orderId, i) => ({
        id: `call-${i}`,
        name: 'lookup_order',
        args: { orderId },
      })),
    },
  ];
}

function hasOrderId(orderId: string) {
  return (toolCall: ToolCall) => toolCall.args.orderId === orderId;
}

describe('aiToolsCalled with repeated tool names', () => {
  it('does not let one call satisfy two expectations', async () => {
    const criterion = aiToolsCalled({
      toolCalls: [{ name: 'lookup_order' }, { name: 'lookup_order' }],
    });

    const result = await criterion.evaluate({ messages: lookups('A-100') });

    expect(result).toMatchObject({
      status: 'failure',
      reason: "Tool 'lookup_order' was not called",
    });
  });

  it('gives each expectation its own call', async () => {
    const criterion = aiToolsCalled({
      toolCalls: [
        { name: 'lookup_order', assertion: hasOrderId('A-100') },
        { name: 'lookup_order', assertion: hasOrderId('B-200') },
      ],
    });

    const result = await criterion.evaluate({ messages: lookups('A-100', 'B-200') });

    expect(result.status).toBe('success');
  });

  describe('assertOrder', () => {
    it('passes each assertion the call at its position', async () => {
      const criterion = aiToolsCalled({
        assertOrder: true,
        toolCalls: [
          { name: 'lookup_order', assertion: hasOrderId('A-100') },
          { name: 'lookup_order', assertion: hasOrderId('B-200') },
        ],
      });

      const result = await criterion.evaluate({ messages: lookups('X-000', 'A-100', 'B-200') });

      expect(result.status).toBe('success');
    });

    it('fails when an earlier call does not match its assertion', async () => {
      const criterion = aiToolsCalled({
        assertOrder: true,
        toolCalls: [
          { name: 'lookup_order', assertion: hasOrderId('B-200') },
          { name: 'lookup_order', assertion: hasOrderId('B-200') },
        ],
      });

      const result = await criterion.evaluate({ messages: lookups('A-100', 'B-200') });

      expect(result).toMatchObject({
        status: 'failure',
        reason: "Tool 'lookup_order' assertion failed",
      });
    });
  });
});
