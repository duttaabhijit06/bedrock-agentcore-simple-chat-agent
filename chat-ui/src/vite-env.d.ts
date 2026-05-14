/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_GATEWAY_URL: string;
  readonly VITE_AWS_REGION: string;
  readonly VITE_RUNTIME_TARGET_NAME: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
