import { vi } from 'vitest'

vi.mock('./env', () => ({
	default: {
		PUBLIC_URL: '',
		VAPID_PUBLIC_KEY: '',
		VAULT_ENDPOINT: '',
	},
}))

globalThis.isSecureContext = true;
