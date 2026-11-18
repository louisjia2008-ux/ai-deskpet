/** unavailable: Lima is not installed. absent: the owner has not created the machine. */
export interface VmSandboxStatus {
  state: 'unavailable' | 'absent' | 'stopped' | 'running' | 'broken';
  busy: 'setup' | 'stop' | 'remove' | null;
  /** The last setup, stop or removal did not finish. */
  failed: boolean;
  sharedFolder: string;
}

export interface VmSandboxAPI {
  status(): Promise<VmSandboxStatus>;
  /** Returns at once; creation and the first start report through onChanged. */
  setup(): Promise<VmSandboxStatus>;
  stop(): Promise<VmSandboxStatus>;
  remove(): Promise<VmSandboxStatus>;
  openFolder(): Promise<void>;
  onChanged(listener: (status: VmSandboxStatus) => void): () => void;
}
