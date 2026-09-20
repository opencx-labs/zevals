import { AutoEvalsScorerCriterion } from '@zevals/autoevals';
import { agentResponse, aiEval, evaluate, message } from '@zevals/core';
import { langChainZEvalsAgent } from '@zevals/langchain';
import { Factuality } from 'autoevals';
import { getTestModel } from './test.util.js';

describe('Autoevals', () => {
  test('Running autoevals scorers', { timeout: 20000 }, async () => {
    const criterion = new AutoEvalsScorerCriterion({
      name: 'factuality',
      scorer: ({ messages }) =>
        Factuality({
          input: messages[0].content.toString(),
          output: messages[1].content.toString(),
          expected: 'Paris',
          // autoevals defaults to the Braintrust proxy, which rejects plain OpenAI keys
          openAiBaseUrl: 'https://api.openai.com/v1',
        }),
    });

    const agent = langChainZEvalsAgent({ runnable: getTestModel() });

    const { getResultOrThrow } = await evaluate({
      agent,

      segments: [
        message({
          role: 'user',
          content: 'What is the capital of France? Answer only with the name.',
        }),

        agentResponse(),

        aiEval(criterion),
      ],
    });

    const criterionOutput = getResultOrThrow(criterion);

    expect(criterionOutput.output.score).toBe(1);
    expect(criterionOutput.status).toBe('success');
  });
});
