# Flock — AI Agent Instructions

## Project Context
**Flock** is a Pastoral Relationship Management (PRM) software designed for personal use to help care for a group of people.
**Core Principle**: Data privacy is paramount. It uses **client-side encryption**. The server **NEVER** sees plaintext data. Even the user must possess their password (and account ID) to decrypt their own data.

## Tech Stack
- **Frontend**: React 19, TypeScript, Material UI (MUI v5), Zustand (Auth/UI state), TanStack Query (Server data/Caching).
- **Network & Sync**: tRPC, native `fetch` (via `trackedFetch`), Offline Queue with Automerge (CRDT) for conflict resolution. *(Note: Axios has been removed).*
- **Backend**: Fastify + tRPC (Vault API), Zod, TypeScript, AWS Lambda.
- **Database**: DynamoDB (Single-table design via drivers).
- **Infrastructure**: SST (Ion), AWS Lambda, Cloudflare Pages, AWS Backup.
- **Testing**: Vitest (Unit), Cypress (E2E) with happy-dom.
- **Styling**: Emotion (styled components), MUI Theming.

## Architecture & Code Structure
- **Root**: Project root is assumed for all commands.
- **Frontend Entry**: `src/index.tsx`
- **Backend Entry**: `src/vault/index.ts` (Lambda environment), `src/vault/api/runServer.ts` (Local dev).

### Key Directories
- `src/api/`: Client-side API clients, encryption wrappers (`Vault.ts`), tRPC clients (`trpcClient.ts`), offline queue management (`offlineQueue.ts`), and session management (`runtime.ts`).
- `src/vault/`: Backend implementation.
    - `src/vault/trpc/`: tRPC routers, schemas, and shared procedure middleware.
    - `src/vault/drivers/`: Database drivers (DynamoDB logic).
- `src/state/`: Zustand stores (`authStore.ts`, `uiStore.ts`) and item models/migrations. (Item migrations run on the client in `src/state/migrations`; server migrations live in `src/vault/migrations`).
- `src/components/`: React UI components. Dialogs and drawers are organized under `src/components/dialogs/` and `src/components/drawers/`.
- `src/workers/`: Web workers, including `decryption.worker.ts` for handling offline queue conflict resolution via Automerge.
- `sst.config.ts`: Infrastructure-as-Code (SST v3) configuration.
- `docker-compose.yml`: Local development service orchestration (DynamoDB, API).

### Data Flow
1. **Read**: TanStack Query caches encrypted items/metadata (`src/api/queries.ts`).
2. **Write & Offline**: Mutations optimistically update the query cache and are routed through the offline queue (`src/api/offlineQueue.ts`). The offline queue uses Automerge serialization to handle branch conflicts.
3. **Storage**: Encrypted data persists in DynamoDB.
4. **State**: Zustand handles UI and Authentication state only.

## Critical Rules & Guidelines

1. **Security First**:
    - **NEVER** add server-side decryption.
    - **NEVER** log secrets or plaintext data.
    - **Client-Side Only**: Plaintext data remains on the client. Clear query cache and local storage via `signOutVault` when changing auth flows.

2. **Encryption Implementation**:
    - Use `src/api/Vault.ts` (or `src/api/vault/` module) helpers: `encryptObject`, `decryptObject`, `encryptObjectAsAutomerge`.

3. **Integration Changes**:
    - Updates typically require changes in both:
        - Client: `src/api/Vault.ts` / `src/api/trpcClient.ts`
        - Server: `src/vault/trpc/routers/*`
    - Shared API contract types live in tRPC router outputs and `src/vault/types.ts`.

4. **Package Management**:
    - **MUST** use `yarn` (Berry, v4.1.0) as configured in `package.json`.
    - **DO NOT** use `npm`.

5. **Shell Commands**:
    - **NO `cd`**: Assume execution from the project root.
    - **Testing**: Prefer `yarn test run` (one-off) over `yarn test` (watch mode).
    - **Context**: Avoid pipe/semicolon/operators inside quoted strings. Skip `2>&1` unless strictly required.

6. **General Agent Instructions**:
    - **Temp files**: If you create files for reading command output, delete them before returning to the user.
    - **In-code comments**: Do not include code comments that reflect your thinking process. Comments that provide concise explanations of the code are good, but refrain from conversational or planning comments inside source files.

## Common Workflows

### Development
- **Install Dependencies**: `yarn install`
- **Start Full Stack**: `yarn start` (Starts Docker for API + DynamoDB and Vite Dev Server).
- **Start Frontend Only**: `yarn dev`
- **Start Backend Only**: `yarn dev:vault` (Fastify via `tsx watch`).
- **Initialize Local DB**: `yarn initdb`

### Testing & Linting
- **Lint**: `yarn lint`
- **Unit Tests**: `yarn test run` (Vitest).
    - Coverage: `yarn coverage`
- **End-to-End**: `yarn e2e` (Cypress run) or `npx cypress open` for interactive mode. Requires dev server running.
- **Pre-commit**: Ensure `lint`, `build`, and `test run` pass. For API work, ensure Docker services are up before testing.

### Build & Deployment
- **Build**: `yarn build` (runs `tsc` then `vite build`)
- **Deploy (SST)**: `yarn deploy --stage <stage>` (e.g., `dev`, `production`).
- **Analyze Bundle**: `yarn analyse`
