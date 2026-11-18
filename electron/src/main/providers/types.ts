import type { ProviderConfig, ProviderModel, ProviderRequestObservation, ProviderUsageTokenDetails } from '../../shared';
import type { ProviderResponseItem } from './response-items';
export type { ProviderResponseItem } from './response-items';

// Ephemeral tool continuation. Its content never enters user messages or receipts.
export interface ProviderToolThought { protocol: 'deepseek' | 'ollama'; content: string; bindingDigest: string }
export interface ProviderChatMessage {
  toolThought?: ProviderToolThought;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsJson: string }>;
  /** Validated output from the preceding Responses turn, including opaque reasoning. */
  responseItems?: ProviderResponseItem[];
}

export interface ProviderToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderChatRequest {
  model: string;
  ollamaNumCtx?: number | undefined;
  /** Release an app-owned Ollama request before a possible vault embedding tool. */
  ollamaReleaseAfterTurn?: true | undefined;
  wireProtocol?: 'responses' | undefined;
  /** Host-selected protocol: this request can only produce plain text. */
  executionMode?: 'background-text';
  messages: ProviderChatMessage[];
  tools?: ProviderToolDefinition[];
  temperature?: number;
  reasoningEffort?: 'none';
  maxOutputTokens?: number;
  outputTokenParameter?: 'max_tokens' | 'max_completion_tokens';
  contextBudget?: {
    contextWindowTokens: number;
    safetyMarginTokens: number;
    /** application-limit bounds host resources; provider capacity is unconfirmed.
     * conservative-fallback is retained for existing frozen jobs. */
    capacitySource: 'configured' | 'provider-reported' | 'conservative-fallback' | 'application-limit';
  };
  identity?: { requestId: string; bindingDigest: string };
}

export interface ProviderModelInspection {
  /** Model metadata ceiling, not proof of the server's active context allocation. */
  contextWindowTokens: number | null;
  executionDestination: 'local' | 'remote' | 'unknown';
  source: 'ollama-show' | 'unknown';
  /** Positive GGUF metadata from the local Ollama endpoint; never a user grant. */
  localGguf?: true | undefined;
}

export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; argumentsJson: string }
  | { type: 'tool-thought'; thought: ProviderToolThought }
  | { type: 'response-items'; items: ProviderResponseItem[] }
  | ({ type: 'usage'; inputTokens: number | null; outputTokens: number | null; reportedCostUSD?: number | null | undefined } & ProviderUsageTokenDetails)
  | { type: 'request-observation'; observation: ProviderRequestObservation }
  | { type: 'done'; finishReason: string | null };

/** Host-side admission only: running means a slot is held, not model output. */
export type ProviderAdmissionState = 'queued' | 'running';

export interface ProviderDispatchOptions {
  /** Recheck asynchronous source authority after admission, before network dispatch. */
  validateBeforeSend?: () => Promise<void>;
  /** Host authority recheck after admission and directly before dispatch. */
  assertCurrent?: () => void;
  /** Never serialized into a request, utility IPC, or persisted task state. */
  onAdmissionState?: (state: ProviderAdmissionState) => void;
}

export interface ProviderAdapter {
  streamChat(request: ProviderChatRequest, signal?: AbortSignal, options?: ProviderDispatchOptions): AsyncGenerator<ProviderStreamEvent>;
  listModels(signal?: AbortSignal): Promise<ProviderModel[]>;
  inspectModel?(model: string, signal?: AbortSignal): Promise<ProviderModelInspection>;
}

export interface ProviderCredentials {
  config: ProviderConfig;
  apiKey: string | null;
}
