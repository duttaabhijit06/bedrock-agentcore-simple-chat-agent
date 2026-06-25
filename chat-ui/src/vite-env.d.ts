/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL: string;
  readonly VITE_AWS_REGION: string;
  readonly VITE_RUNTIME_TARGET_NAME: string;
  /** Lookback window (in hours) for the conversation-history sidebar. Default 48. */
  readonly VITE_HISTORY_WINDOW_HOURS?: string;
  /** Background poll cadence (in seconds) for the sidebar. 0 disables. Default 30. */
  readonly VITE_HISTORY_POLL_SECONDS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
