/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly DEV: boolean;
  readonly PROD: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "virtual:mex-hub-fixture-api" {
  import type { FixtureApiOptions, HubApi } from "./api/client";

  export const createFixtureApi: ((options?: FixtureApiOptions) => HubApi) | null;
}
