# Flock — AI Agent Instructions

## Project Context
**Flock** is a Pastoral Relationship Management (PRM) software designed for personal use to help care for a group of people.
**Core Principle**: Data privacy is paramount. It uses **client-side encryption**. The server **NEVER** sees plaintext data. Even the user must possess their password (and account ID) to decrypt their own data.

## Tech Stack
- **Frontend**: React 19, TypeScript, Material UI (MUI v5), Redux Toolkit (Auth/UI state), TanStack Query (Server data/Caching).
- **Backend**: Fastify (Vault API), TypeScript, AWS Lambda.
- **Database**: DynamoDB (Single-table design via drivers).
- **Infrastructure**: SST (Ion), AWS Lambda, Cloudflare Pages, AWS Backup.
- **Testing**: Vitest (Unit), Cypress (E2E).
- **Styling**: Emotion (styled components), MUI Theming.

## Architecture & Code Structure
- **Root**: `/home/david/flock`
- **Frontend Entry**: `src/index.tsx`
- **Backend Entry**: `src/vault/index.ts` (Lambda environment), `src/vault/api/runServer.ts` (Local dev).

### Key Directories
- `src/api/`: Client-side API clients, encryption wrappers (`Vault.ts`, `VaultAPI.ts`), and session management (`axios.ts`).
- `src/vault/`: Backend implementation.
    - `src/vault/api/routes/`: Fastify routes defined with TypeBox schemas.
    - `src/vault/drivers/`: Database drivers (DynamoDB logic).
- `src/state/`: Redux slices (`account.ts`, `ui.ts`) and item models/migrations.
- `src/components/`: React UI components (MUI based).
- `sst.config.ts`: Infrastructure-as-Code (SST v3) configuration.
- `docker-compose.yml`: Local development service orchestration (DynamoDB, API).

### Data Flow
1.  **Read**: TanStack Query caches encrypted items/metadata (`src/api/queries.ts`).
2.  **Write**: Mutations optimistically update the query cache, then invalidate to refetch.
3.  **Storage**: Encrypted data persists in DynamoDB.
4.  **State**: Redux handles UI state and Authentication only.

## Critical Rules & Guidelines
1.  **Security First**:
    - **NEVER** add server-side decryption.
    - **NEVER** log secrets or plaintext data.
    - **Client-Side Only**: Plaintext data remains on the client.
2.  **Encryption Implementation**:
    - Use `src/api/Vault.ts` helpers: `encryptObject`, `decryptObject`, `storeItems`, `deleteItems`.
    - Use `src/api/VaultAPI.ts` HTTP wrapper for backend calls.
3.  **Package Management**:
    - **MUST** use `yarn` (Berry, v4.1.0) as configured in `package.json`.
    - **DO NOT** use `npm`.
4.  **Shell Commands**:
    - **NO `cd`**: Assume execution from the project root.
    - **Testing**: Prefer `yarn test run` (one-off) over `yarn test` (watch mode).
    - **Context**: Avoid pipe/operators inside quoted strings.
5.  **Integration Changes**:
    - Updates typically require changes in both:
        - Client: `src/api/Vault.ts` / `src/api/VaultAPI.ts`
        - Server: `src/vault/api/routes/*`
    - Logic often shared via types in `src/shared/apiTypes.ts`.

## Common Workflows (Commands)

### Development
- **Install Dependencies**: `yarn install` (Also runs `patch-package`).
- **Start Full Stack**: `yarn start` (Requires Docker).
    - Starts Docker (API + DynamoDB) and Vite Dev Server.
- **Start Frontend Only**: `yarn dev`
- **Start Backend Only**: `yarn dev:vault` (Fastify watch mode).
- **Initialize Local DB**: `yarn initdb`

### Testing
- **Unit Tests**: `yarn test` (Vitest).
    - Coverage: `yarn coverage`
- **End-to-End**: `yarn e2e` (Cypress).
    - Requires dev server running.
    - Helper: `npx cypress open` for interactive mode.

### Deployment
- **Deploy (SST)**: `yarn deploy --stage <stage>` (e.g., `dev`, `production`).
- **Build**: `yarn build` (Frontend) / `yarn build:vault` (Backend Lambda).

## Formatting & Linting
- **Lint**: `yarn lint`
- **Pre-commit**: Ensure `lint`, `build`, and `test` pass.
