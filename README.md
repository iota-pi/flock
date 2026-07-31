# Flock

Flock is Pastoral Relationship Management (PRM) software. Our prayer is that
Flock will help you to care diligently for the flock of God that is among you.

## Intent

Flock is intended as a tool to help you to care for and serve the people you
personally look after. It is not designed to be used by multiple users,
or to share data between users.

Because Flock is a personal tool, any data you enter should not belong to your
organisation or church.

## Security

Any data you enter is stored encrypted using "client-side encryption"
(sometimes also referred to as end-to-end encryption). Practically speaking,
this means that there is no way for anyone (including you) to read or recover
your data without your password (and the account ID generated when you create
your account).

As such, the security of Flock can only be as good as your own online security.
We **strongly** recommend using a password manager to create and record a
strong password and your account ID.

## Disclaimer

Flock is free software, provided as-is, with no guarantee of data retention,
security, or availability. By choosing to use Flock, you agree that the
creators and contributors shall not be liable for any damages or losses
related to or resulting from the use of Flock.

# Development

This repository is for the development of Flock. If you want to use Flock,
go to [flock.cross-code.org](https://flock.cross-code.org/).

## Architecture At A Glance

Flock is a unified TypeScript codebase containing:

- A React frontend (`src/`)
- A Fastify + tRPC Vault API (`src/vault/`)
- A local-first Automerge sync layer (`src/sync/`, `src/workers/`)

### Key directories

```
flock/
├── src/
│   ├── api/                 # Frontend API clients, auth/session/runtime helpers
│   │   ├── vault/           # Encrypted Vault HTTP clients + sync transport
│   │   └── realtime/        # Realtime transport and lock helpers
│   ├── components/          # React components (dialogs, drawers, pages, layout)
│   ├── features/            # Feature slices (items, groups, etc)
│   ├── hooks/               # Shared React hooks
│   ├── state/               # App state stores and domain models
│   ├── sync/                # Automerge doc store, dispatcher, coordinator, migrations
│   ├── workers/             # Web workers + managers (Automerge and item processing)
│   └── vault/               # Backend API (Fastify/tRPC, services, DynamoDB drivers)
├── cypress/                 # End-to-end tests
├── public/                  # Static assets
├── sst.config.ts            # SST infrastructure definition
└── docker-compose.yml       # Local DynamoDB + API dependencies
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Material UI, Vite
- **State**: Zustand stores + local-first Automerge document snapshots
- **Sync**: Automerge CRDTs, worker-backed sync state, batch push/pull over encrypted HTTP
- **Realtime**: WebSocket transport with web-lock leader election and cross-tab bus
- **Backend**: Fastify, tRPC, Zod, TypeScript, DynamoDB
- **Infrastructure**: SST (Ion), AWS Lambda, Cloudflare Pages, AWS Backup
- **Testing**: Vitest + happy-dom, Cypress

## Local-First Data Flow

1. Item and metadata reads come from local Automerge snapshots.
2. Local edits update Automerge docs immediately on the client.
3. The sync dispatcher pushes only documents marked with local changes.
4. Remote changes are pulled in batches and merged into the same local docs.
5. Realtime sync pings trigger targeted pull/catch-up across tabs.

## Setup

Requirements:

1. Node.js v26+
2. Yarn 4 (via Corepack)
3. Docker with Compose

```shell
yarn install
docker compose up -d
yarn initdb
```

## Run Locally

```shell
# Start Docker services, Vault API, and Vite app
yarn start
```

Run services individually when needed:

```shell
# Frontend only
yarn dev

# Vault API only (watch mode)
yarn dev:vault
```

## Testing And Quality

```shell
# Lint
yarn lint

# Unit tests (single run)
yarn test run

# Coverage
yarn coverage

# Cypress e2e run
yarn e2e

# Cypress interactive mode
npx cypress open
```

## Build And Deploy

```shell
# Type-check + frontend build
yarn build

# Deploy with SST
yarn deploy --stage <stage>
```

`sst.config.ts` provisions DynamoDB, Lambda (Vault API), Cloudflare Pages, and backup resources.
