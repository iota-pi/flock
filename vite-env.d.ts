/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_RELEASE?: string
  readonly VITE_VAPID_PUBLIC_KEY?: string
  readonly VITE_VAULT_ENDPOINT?: string
}
