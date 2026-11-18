export interface ReaTarget { id: string; sessionId: string; name: string; identitySHA256: string; files: number; bytes: number; kind: 'directory' | 'asar' }
export interface ReaResult {
  id: string; targetId: string; sessionId: string; targetIdentitySHA256: string;
  tool: 'analyze_javascript_application' | 'inspect_analysis_view'; text: string; truncated: boolean;
  untrusted: true; privacy: 'local-only';
}
export interface ReaStatus {
  available: boolean; version: string | null; active: boolean;
  enabled?: boolean; reasonCode?: string; verified?: boolean; checkedAt?: string | null;
}
export interface ReaAPI {
  status(): Promise<ReaStatus>;
  checkRuntime(): Promise<ReaStatus>;
  chooseTarget(input: { sessionId: string }): Promise<ReaTarget | null>;
  analyze(input: { sessionId: string; targetId: string }): Promise<ReaResult>;
  inspect(input: { sessionId: string; targetId: string; resultId: string; view: 'summary' | 'modules' | 'boundaries' }): Promise<ReaResult>;
  cancel(input: { sessionId: string }): Promise<void>;
  ask(input: { sessionId: string; resultId: string; question: string; providerId: string; model: string }): Promise<{ runId: string }>;
}
