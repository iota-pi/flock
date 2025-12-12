<!-- Copilot instructions for the Flock repository -->
# Flock — Copilot / AI Agent Guidance

This file gives focused, actionable guidance to an AI coding agent working in the Flock repository. Keep instructions concrete and reference code examples so an agent can be immediately productive.

## Repository layout

This is a unified TypeScript project (not a monorepo) containing both the front-end React application and the back-end Vault API:

```
flock/
├── src/
│   ├── api/             # Front-end API clients
│   │   ├── Vault.ts     # Encryption & vault operations
│   │   ├── VaultAPI.ts  # HTTP API wrapper
│   │   └── axios.ts     # Axios instance configuration
│   ├── components/      # React UI components
│   ├── hooks/           # Custom React hooks
│   ├── state/           # Redux slices (account.ts, items.ts, ui.ts)
│   ├── utils/           # Utility functions
│   └── vault/           # Back-end Vault API (runs as Lambda)
│       ├── api/         # Fastify server, routes
│       │   ├── index.ts       # createServer entry
│       │   ├── runServer.ts   # Local dev server entry
│       │   └── routes/        # API route handlers
│       ├── drivers/     # Database drivers
│       │   ├── dynamo.ts      # DynamoDB implementation
│       │   └── init.ts        # DB initialization script
│       ├── migrations/  # Data migrations
│       └── notifier/    # Notification services
├── cypress/             # E2e tests
├── public/              # Static assets
├── sst.config.ts        # SST infrastructure config (Lambda, DynamoDB, Cloudflare)
├── docker-compose.yml   # Local dev services (DynamoDB, API)
├── vite.config.ts       # Vite bundler config
└── vitest.config.ts     # Test runner config
```

Key entry points:
- **Front-end entry**: `src/index.tsx`
- **Vault API entry (Lambda)**: `src/vault/index.ts` (exports `handler`)
- **Vault API entry (local dev)**: `src/vault/api/runServer.ts`
- **DB initialization**: `src/vault/drivers/init.ts`

## Quick developer workflows

### Installation
```sh
yarn install
```

### Start services locally
```sh
# Start DynamoDB and API via Docker, then run Vite dev server
yarn start
```

This runs `docker compose up -d api` followed by SST dev mode.

Alternatively, run services individually:
```sh
# Start just the Docker services (DynamoDB + API)
docker compose up -d

# Run Vault API locally with hot reload (outside Docker)
yarn dev:vault

# Initialize local DynamoDB tables
yarn initdb
```

### Docker Compose services
- `dynamodb` — Amazon DynamoDB Local. Port: 8000. Volume: `dynamodata`.
- `api` — Vault API service. Port: 4000. Depends on `dynamodb`. Uses `yarn dev:vault`.

### Testing
```sh
# Unit tests (Vitest)
yarn test

# With coverage
yarn coverage

# E2e tests (Cypress) — ensure dev server is running
npx cypress open
```

### Linting & type-checking
```sh
yarn lint
yarn build  # runs tsc then vite build
```

### Deployment (SST)
```sh
# Deploy to a stage
yarn deploy --stage <stage-name>

# Deploy to staging
yarn deploy --stage dev

# Deploy to production
yarn deploy --stage production
```

## Architecture & patterns

### Separation of concerns
- The **front-end** is a single-page React app built with Vite
- The **back-end** (`src/vault/`) is a Fastify HTTP API deployed as an AWS Lambda with a Function URL
- Storage is abstracted behind drivers (`src/vault/drivers/*`); DynamoDB is the production driver

### Client-side encryption
The front-end encrypts all user data before sending to the vault. See:
- `src/api/Vault.ts` — encryption logic and vault operations
- `src/api/VaultAPI.ts` — HTTP API wrapper

**Important**: The server never has plaintext. Do not add server-side decryption — follow established patterns in `src/api/*`.

### State management
- TanStack Query holds all server data (items + metadata); mutations live in `src/api/queries.ts`.
- Redux Toolkit is kept for UI/auth-only state:
	- `src/store.ts` — store configuration
	- `src/state/account.ts` — account/auth flags (no metadata)
	- `src/state/items.ts` — item models/helpers (no Redux slice)
	- `src/state/ui.ts` — UI state
	- `src/state/selectors.ts` — memoized selectors wrapping Query + UI

### Infrastructure (SST)
Infrastructure is defined in `sst.config.ts` using SST v3:
- **DynamoDB tables**: FlockAccounts, FlockItems, FlockSubscriptions
- **Lambda + Function URL**: Vault API
- **Cloudflare Pages**: Static site hosting
- **AWS Backup**: Automated backups with point-in-time recovery

## Conventions

### Package management
- **Yarn 4** is used (`packageManager` in package.json is `yarn@4.1.0`)
- Use `yarn` commands, not `npm`
- `patch-package` runs on postinstall — patches are in `patches/`

### TypeScript
- Single `tsconfig.json` at root
- Build runs `tsc` before `vite build`
- Lambda is bundled separately via esbuild (`yarn build:vault`)

### Testing
- Unit tests: `**/*.spec.ts` files, run with Vitest
- E2e tests: `cypress/e2e/*.cy.ts`

## Integration points & key files

### When modifying API contracts
- `src/api/Vault.ts`, `src/api/VaultAPI.ts` — client-side API usage
- `src/vault/api/routes/*` — server-side route handlers
- `cypress/e2e/*` — e2e tests that validate integration

### When modifying state
- `src/store.ts` — Redux store setup
- `src/state/*` — individual slices

### When modifying infrastructure
- `sst.config.ts` — all AWS and Cloudflare resources
- `docker-compose.yml` — local development services

## Edge cases and constraints

### Security
- Client-side encryption means server never sees plaintext
- Personal data only — not designed for multi-user or data sharing
- Be cautious about adding sharing features without security review

### Environment variables
Local development uses:
- `DYNAMODB_ENDPOINT=http://dynamodb:8000` (set in docker-compose.yml)
- `PROD_APP_URL=https://flock.cross-code.org`
- `NODE_ENV=development`

For SST deployment, secrets are managed via SST's secret management.

## Pre-commit checks

Before committing changes:
```sh
yarn lint          # ESLint
yarn build         # TypeScript + Vite build
yarn test run      # Unit tests
```

For API changes, ensure Docker services are running and test the integration manually or via Cypress.

## Enforce safe command-line composition!
When generating shell or terminal commands:
- Never include the pipe (`|`), semicolon (`;`), or other shell control operators inside quoted strings (within `"..."` or `'...'`). Copilot Chat misinterprets these as command separators, breaking the line into multiple subcommands and triggering unnecessary approval prompts.
- When running scripts in the terminal, assume the working directory is the project root and avoid using `cd` commands
- Do not redirect output using 2>&1 unless necessary
- Prefer `yarn test run` instead of `yarn test`
