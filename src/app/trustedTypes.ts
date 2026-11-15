// The default Trusted Types policy. Once the CSP requires Trusted Types for scripts, every string
// passed to a script-URL or HTML sink goes through this policy, and anything it throws on is
// blocked. Import this module before any other so the policy exists before the first sink runs.
//
// What reaches it:
// - Script URLs: `new Worker` for the vault, KDF and migration workers, and workbox-window's
//   `navigator.serviceWorker.register`. All are same-origin.
// - HTML: the MUI X date field writes its section text (digits, month names and placeholders
//   such as `MM`) with `innerHTML`. Nothing else in Flock writes HTML.

// TypeScript's DOM lib has no Trusted Types declarations yet
interface TrustedTypePolicyOptions {
  createHTML?: (input: string) => string,
  createScriptURL?: (input: string) => string,
}
export interface TrustedTypePolicyFactory {
  createPolicy(name: string, options: TrustedTypePolicyOptions): unknown,
}

const HTML_MARKUP = /[<&]/

export function createDefaultPolicyOptions(origin: string): TrustedTypePolicyOptions {
  return {
    createScriptURL: (input: string) => {
      if (new URL(input, origin).origin === origin) {
        return input
      }
      throw new TypeError(`Blocked a script URL from another origin: ${input}`)
    },
    createHTML: (input: string) => {
      if (!HTML_MARKUP.test(input)) {
        return input
      }
      throw new TypeError('Blocked HTML containing markup')
    },
  }
}

export function installDefaultTrustedTypesPolicy(
  factory: TrustedTypePolicyFactory | undefined,
  origin: string,
) {
  factory?.createPolicy('default', createDefaultPolicyOptions(origin))
}

if (typeof window !== 'undefined') {
  const { trustedTypes } = window as { trustedTypes?: TrustedTypePolicyFactory }
  installDefaultTrustedTypesPolicy(trustedTypes, window.location.origin)
}
