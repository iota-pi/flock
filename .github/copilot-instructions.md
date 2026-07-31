# Flock — AI Agent Instructions

## Project Context
**Flock** is a Pastoral Relationship Management (PRM) software designed for personal use to help care for a group of people.
**Core Principle**: Data privacy is paramount. It uses **client-side encryption**. The server **NEVER** sees plaintext data. Even the user must possess their password (and account ID) to decrypt their own data.

## Tech Stack
- **Frontend**: React 19, TypeScript, Material UI (MUI v7), Zustand.
- **Network & Sync**: tRPC + native `fetch` clients, local-first Automerge sync (worker-backed), batch push/pull transport.
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
- `src/api/`: Client-side API clients, runtime/session state, realtime coordination, and encrypted Vault client modules under `src/api/vault/`.
- `src/sync/`: Local Automerge store, sync dispatcher, sync coordinator, migration/bootstrap, recovery/session helpers.
- `src/workers/`: Worker implementations and managers (`automergeDoc.worker.ts`, `automergeDocWorkerManager.ts`, `item.worker.ts`).
- `src/vault/`: Backend implementation.
    - `src/vault/trpc/`: tRPC routers, schemas, and shared procedure middleware.
    - `src/vault/services/`: API service layer including sync/realtime behavior.
    - `src/vault/drivers/`: Database drivers (DynamoDB logic).
- `src/state/`: Zustand stores and domain models/migrations. (Client migrations: `src/state/migrations`; server migrations: `src/vault/migrations`).
- `src/components/`: React UI components. Dialogs and drawers are organized under `src/components/dialogs/` and `src/components/drawers/`.
- `sst.config.ts`: Infrastructure-as-Code (SST v3) configuration.
- `docker-compose.yml`: Local development service orchestration (DynamoDB, API).

### Data Flow
1. **Read**: Item/metadata reads come from local Automerge snapshots (`src/sync/automergeDocStore.ts`, hooks in `src/sync/useAutomerge.ts`).
2. **Write**: Local mutations update Automerge docs immediately on the client.
3. **Push**: Sync dispatcher pushes only docs marked with local changes (`hasLocalChanges`).
4. **Pull/Merge**: Remote updates are pulled in batches and merged into Automerge docs.
5. **Realtime**: WebSocket `sync_ping` and cross-tab bus events coordinate targeted pulls and leader sync behavior.

## Critical Rules & Guidelines

1. **Security First**:
    - **NEVER** add server-side decryption.
    - **NEVER** log secrets or plaintext data.
    - **Client-Side Only**: Plaintext data remains on the client.

2. **Encryption Implementation**:
    - Use helpers in `src/api/vault/crypto.ts` and related vault client modules for encryption/decryption primitives.

3. **Integration Changes**:
    - Updates typically require changes in both:
        - Client: `src/api/vault/*`, sync modules under `src/sync/*`
        - Server: `src/vault/trpc/routers/*` and/or `src/vault/services/*`
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
- **Focused sync/worker tests**: prefer running specific specs first (for example worker manager or sync dispatcher specs) before full suite runs.
- **Pre-commit**: Ensure `lint`, `build`, and `test run` pass. For API work, ensure Docker services are up before testing.

### Build & Deployment
- **Build**: `yarn build` (runs `tsc` then `vite build`)
- **Deploy (SST)**: `yarn deploy --stage <stage>` (e.g., `dev`, `production`).
- **Analyze Bundle**: `yarn analyse`
