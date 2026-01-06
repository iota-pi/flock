<!-- Copilot instructions for the Flock repository -->
# Flock — Copilot / AI Agent Guidance

- Unified TypeScript repo: React front-end (entry: src/index.tsx) + Fastify vault API (lambda: src/vault/index.ts, local dev: src/vault/api/runServer.ts).
- Client-side encryption only; never add server-side decryption. Use helpers in src/api/Vault.ts (encryptObject/decryptObject, storeItems/deleteItems). Session handling lives in src/api/axios.ts via initAxios/setSessionExpiredHandler.
- Data flow: TanStack Query caches items/metadata (queryClient/queryKeys/fetchItems in src/api/queries.ts). Mutations optimistically update query cache then invalidate; Redux is UI/auth-only (src/state/account.ts, ui.ts; items.ts holds models/migrations; selectors wrap Query + UI).
- Vault storage uses DynamoDB driver at src/vault/drivers/dynamo.ts; routes under src/vault/api/routes/ are Fastify+TypeBox. Item migrations run on the client in src/state/migrations; server migrations live in src/vault/migrations.
- Theming/UI: MUI v5 with wrapper in src/ThemedApp.tsx and theme config in src/theme.tsx; markdown rendered via src/components/Markdown.tsx; dialogs and drawers under src/components/dialogs and src/components/drawers.
- Dev workflows: yarn install; yarn start (docker compose up -d api + Vite/SST dev). Alternatives: docker compose up -d, yarn dev (front only), yarn dev:vault (Fastify via tsx watch), yarn initdb (local Dynamo setup). Env defaults are provided by docker-compose.
- Build/deploy: yarn build (tsc then vite build), yarn build:vault (esbuild bundle + lambda.zip), yarn deploy --stage <stage>, yarn analyse for bundle inspection.
- Testing: yarn test (Vitest), yarn coverage, yarn e2e (cypress run) or npx cypress open. happy-dom configured in src/setupTests.ts; cypress specs in cypress/e2e/.
- Integration changes: update both client (src/api/Vault.ts, src/api/VaultAPI.ts) and server routes (src/vault/api/routes/*); adjust types in src/shared/apiTypes.ts and refresh e2e coverage.
- Infrastructure: SST v3 config in sst.config.ts provisions DynamoDB tables (FlockAccounts/FlockItems/FlockSubscriptions), Lambda Function URL, Cloudflare Pages, AWS Backup. Local services defined in docker-compose.yml.
- Safety rules: keep plaintext on the client; do not log secrets; clear query cache and local storage via signOutVault when changing auth flows. Preserve Yarn 4 usage (packageManager: yarn@4.1.0); avoid npm.
- Pre-commit sanity: yarn lint, yarn build, yarn test run (for coverage use yarn coverage). For API work, ensure Docker services are up before testing.
- Shell composition: avoid putting pipe/semicolon/operators inside quoted strings; assume project root; avoid `cd`; skip `2>&1` unless required; prefer `yarn test run` over `yarn test`.
