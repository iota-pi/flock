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

This repository is for the development of Flock, if you would like to use Flock,
please go to [flock.cross-code.org](https://flock.cross-code.org/).

## Project Structure

This is a unified TypeScript project containing both the front-end React application and the back-end Vault API:

```
flock/
├── src/
│   ├── api/           # Front-end API clients (Vault.ts, VaultAPI.ts, axios.ts)
│   ├── components/    # React UI components
│   ├── hooks/         # Custom React hooks
│   ├── state/         # UI state slices (account, ui) and item models/helpers
│   ├── utils/         # Utility functions
│   └── vault/         # Back-end Vault API
│       ├── api/       # Fastify server and routes
│       ├── drivers/   # Database drivers (DynamoDB)
│       ├── migrations/
│       └── notifier/  # Notification services
├── cypress/           # End-to-end tests
├── public/            # Static assets
├── sst.config.ts      # SST infrastructure configuration
└── docker-compose.yml # Local development services
```

## Tech Stack

- **Front-end**: React, TypeScript, TanStack Query (server data), Redux Toolkit (UI state), MUI (Material UI), Vite
- **Back-end**: Fastify, TypeScript, DynamoDB
- **Infrastructure**: SST (Ion), AWS Lambda, Cloudflare Pages
- **Testing**: Vitest (unit tests), Cypress (e2e tests)

## Set up

Requirements:
1. Node.js (v22+)
2. Yarn 4 (via Corepack)
3. Docker & Docker Compose

```shell
# Install dependencies
yarn install

# Start local DynamoDB and API
docker compose up -d

# Initialize the local database
yarn initdb
```

## Run development server

```shell
# Start Docker services and Vite dev server
yarn start
```

This command:
1. Starts the local DynamoDB and API containers via Docker Compose
2. Runs the Vite development server with SST dev mode

Alternatively, run individual services:

```shell
# Run Vault API locally (with hot reload)
yarn dev:vault

# Run just the front-end (requires API to be running)
yarn dev
```

## Testing

```shell
# Run unit tests
yarn test

# Run unit tests with coverage
yarn coverage

# Run Cypress e2e tests (ensure dev server is running)
npx cypress open
```

## Deployment

Infrastructure is managed via [SST](https://sst.dev/) (v3):

```shell
# Deploy to a development stage
yarn deploy --stage dev

# Deploy to production
yarn deploy --stage production
```

The SST configuration (`sst.config.ts`) provisions:
- DynamoDB tables (FlockAccounts, FlockItems, FlockSubscriptions)
- Lambda function with Function URL for the Vault API
- Cloudflare Pages for static site hosting
- AWS Backup for data protection
