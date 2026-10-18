/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL of tools/stems/separation_server.py when it isn't on this machine (deployed builds). */
  readonly VITE_SERVICE_URL?: string;
}
