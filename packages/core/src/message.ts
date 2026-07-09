export type ToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
};

export type UserMessage = {
  role: 'user';
  content: string;
  /**
   * Opaque, user-defined data attached to the message (attachments, channel metadata, etc.).
   * Zevals passes it through untouched to {@link Agent.invoke}; it is never sent to judges.
   */
  context?: Record<string, unknown>;
};
export type ToolResultMessage = {
  role: 'tool';
  tool_call_id?: string;
  name: string;
  content: Record<string, unknown>;
};
export type SystemMessage = { role: 'system'; content: string };

/**
 * The context that was used by the agent to generate a response.
 * Uses BaseMessage (non-recursive) to avoid circular type references that cause TypeScript heap overflow.
 */
export type AgentResponseGenerationContext = {
  /**
   * Messages that were used as prompts to produce the response.
   * If not specified, the chat history prior to the response will be used for evaluation.
   */
  prompt_used?: Array<
    | UserMessage
    | ToolResultMessage
    | SystemMessage
    | { role: 'assistant'; content: string; tool_calls?: Array<ToolCall> }
  >;
  /** The tool calls that were made by the LLM. */
  tool_calls?: Array<ToolCall>;
};

export type AIMessage = {
  role: 'assistant';
  content: string;
  tool_calls?: Array<ToolCall>;
  context?: AgentResponseGenerationContext;
};

export type Message = AIMessage | UserMessage | ToolResultMessage | SystemMessage;
