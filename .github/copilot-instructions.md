<!-- Copilot instructions for the Flock repository -->
# Flock — Copilot / AI Agent Guidance

This file gives focused, actionable guidance to an AI coding agent working in the Flock monorepo. Keep instructions concrete and reference code examples so an agent can be immediately productive.

Repository layout (high level)
- `app/` — React + TypeScript front-end. Entry: `app/src/index.tsx`. Dev server: `yarn start` (runs vite and starts the API via docker).
- `vault/` — Storage and API (Fastify + TypeScript). Dev server entry: `vault/api/runServer.ts`. DB driver init: `vault/drivers/init.ts`.
- `infra/`, `deploy/` — Terraform and deploy scripts.

Quick developer workflows (commands you can run)
- Install (from repo root):
  - `cd app && yarn install`
  - `cd ../vault && yarn install`
- Start services locally (recommended):
 - Start services locally (recommended):
 - Start services locally (recommended):
  - `docker compose up -d` — starts the API, local DynamoDB and other dependencies defined in `docker-compose.yml` (DynamoDB is run locally via the compose service).
    - Services defined in `docker-compose.yml`:
      - `dynamodb` — Amazon DynamoDB Local image. Port: host 8000 -> container 8000. Volume: `dynamodata`.
      - `api` — the `vault` API service. Depends on `dynamodb`. Port: host 4000 -> container 4000. Environment vars set in compose include `DYNAMODB_ENDPOINT=http://dynamodb:8000`, `PROD_APP_URL`, `GOOGLE_APPLICATION_CREDENTIALS`, and `NODE_ENV=development`.
      - `terraform` — a helper container using HashiCorp Terraform (used for infra operations only; it runs `tail -f /dev/null` by default).
    - To bring up only the API and DynamoDB for local dev:
      ```sh
      docker compose up -d dynamodb api
      ```
  - `cd app && yarn start` — starts Vite and runs `yarn vault:dev` which brings up the `api` service via Docker Compose.
- Vault helper scripts (in `vault/package.json`):
  - `yarn dev` — run API with `nodemon` (file changes restart server)
  - `yarn initdb` — initialize local test DB via `vault/drivers/init.ts`
  - Docker helpers: `yarn docker`, `yarn docker:test`, `yarn docker:initdb` (via docker compose)

Architecture & patterns
- Separation of concerns: the front-end is a single-page React app; the back-end (`vault`) is a small Fastify HTTP API that abstracts storage behind driver implementations (`vault/drivers/*`). Use the drivers module to locate storage-specific logic; `getDriver('dynamo')` is used to access Dynamo-related behaviour.
- Client-side encryption: The front-end stores user data encrypted (see `app/src/api/Vault.ts` and `app/src/api/VaultAPI.ts` for how the client constructs requests to the vault). Respect the encryption flow — changing request/response shapes requires careful consideration of cryptographic flows.
- Tests: both `app` and `vault` use Vitest. Front-end also includes Cypress e2e tests under `app/cypress/e2e`.

Conventions and notable project-specific patterns
- Yarn 4 (PNM v4) is used — `packageManager` in package.json is `yarn@4.1.0`. Use `yarn` commands not `npm`.
- The `app` start script runs `yarn vault:dev` (which shells to `docker compose up -d api`) before starting Vite. When making changes that affect API types or contracts, prefer running the `vault` API locally via `yarn dev` or through Docker to mirror runtime.
- Patch-package: `app` uses `patch-package` postinstall. If adding/updating dependencies that require patching upstream packages, update `app/patches/` and keep patches minimal.
- TypeScript: project uses `tsconfig.json` per package. `app` compiles types with `tsc` during `build` step before `vite build`.

Integration points & important files to inspect when changing behavior
- Front-end API clients: `app/src/api/Vault.ts`, `app/src/api/VaultAPI.ts`, `app/src/api/axios.ts`.
- Redux state and selectors: `app/src/store.ts`, `app/src/state/*` (account, items, ui). Look here for global state changes.
- Fastify server boot: `vault/api/runServer.ts` and `vault/api/index.ts` (createServer entry) — changes to routing, plugins, or auth commonly live here.
- DB drivers and DB init: `vault/drivers/*` and `vault/drivers/init.ts`.
- Tests: `app/cypress` for e2e; `**/*.spec.ts` and vitest config files (`app/vitest.config.ts`, `vault/vitest.config.ts`) for unit tests.

When editing code, prefer these small checks before committing
- Run lint and typecheck quickly:
  - `cd app && yarn lint` and `cd vault && yarn lint` (eslint may be minimal; also run `tsc` via `yarn build` in `app`).
- Run unit tests (fast): `cd app && yarn test` and `cd vault && yarn test`.
- For server-side changes, restart the server (`yarn dev` in `vault`) or redeploy Docker compose (`docker compose up -d api`) and re-run the front-end if it depends on changed responses.

Examples to reference in code changes
- To see how the API is started: `vault/api/runServer.ts`.
- To see DB init usage: `vault/drivers/init.ts`.
- To see front-end boot including service worker: `app/src/index.tsx` and `app/src/serviceWorkerRegistration.ts`.

Edge cases and constraints
- Encryption/secret handling: client-side encryption means the server never has plaintext. Avoid attempts to add server-side decryption flows — instead follow the established patterns in `app/src/api/*`.
- Small team, personal-data expectations: data is assumed to be personal and not shared between accounts. Be cautious about adding multi-user or sharing features without reviewing security implications.

If you modify or add public APIs, update these files:
- `app/src/api/*` — client usage & tests
- `vault/api/*` — server routes and contract
- `app/cypress/**` or `**/*.spec.ts` — tests that validate the integration

- Local DB & infra assumptions: DynamoDB is run locally via Docker Compose (see `docker-compose.yml`) — use `docker compose up -d` to bring it up for development and tests. Terraform under `infra/` is intended for production/staging deployments only; local development should not require Terraform unless a maintainer documents a specific local Terraform flow.
 - Local DB & infra assumptions: DynamoDB is run locally via Docker Compose (see `docker-compose.yml`) — use `docker compose up -d` to bring it up for development and tests. The compose file defines `dynamodb`, `api`, and a `terraform` helper container. The `api` service sets environment variables including `DYNAMODB_ENDPOINT`, `PROD_APP_URL`, and `GOOGLE_APPLICATION_CREDENTIALS` — ensure any referenced credential files (for example the GCP JSON key) are available in the project root or documented in the repo.

If this help needs to be expanded, tell me which areas you'd like more automation for (CI checks, local debug scripts, more example-driven recipes).
