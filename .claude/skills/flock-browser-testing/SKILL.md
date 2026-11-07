---
name: flock-browser-testing
description: How to run and manually test Flock in the built-in browser pane quickly, covering starting the dev servers, signing up or logging in with a local test account, driving forms that swallow input, timing sync with an indicator recorder and the API logs, and simulating offline. Use this whenever you need to see a Flock change working in the real app, verify UI or sync behaviour in the browser, reproduce a bug by hand, or take a screenshot of the app, even if the user only says "check it works" or "try it in the app". Not for writing or running Cypress specs.
---

# Testing Flock in the browser pane

This is the fast path through a local manual test. Most of the time lost in a first attempt goes on the setup traps below, so follow the order here. It only applies to `localhost`: never use these steps or the test password against a deployed site.

## 1. Start up

1. Check that Docker's `flock-dynamodb-1` is running (`docker compose ps`). If it isn't, run `docker compose up -d`, then `yarn initdb` with `DYNAMODB_ENDPOINT=http://localhost:8000`.
2. Call `preview_start` with `{name: "api"}` and `{name: "app"}` from `.claude/launch.json`. Keep both `serverId`s for logs and cleanup. The `api` call also opens a pointless tab, so pass `tabId` from the `app` result on every browser call.
3. Show the pane with `mcp__ccd_view__show_pane` (`pane: "preview"`). A hidden pane has a 0x0 viewport and runs as a background page, which makes screenshots and timings unreliable.
4. Wait for the app rather than reloading it. A cold Vite start compiles about 250 modules and leaves `#root` empty for around 30 seconds, with no console errors. That's normal, and reloading only restarts the wait. Poll in one call:

```js
for (let i = 0; i < 120 && !document.getElementById('root')?.children.length; i++) await new Promise(r => setTimeout(r, 500))
;({ path: location.pathname, cy: [...document.querySelectorAll('[data-cy]')].map(e => e.dataset.cy).slice(0, 30) })
```

`javascript_tool` allows top-level `await`, so a wait of 30 seconds or more can run in a single call. Use this polling shape after any navigation instead of repeated reads. Listing `data-cy` values is the quickest way to see where you are, and they match the selectors in `cypress/support/commands.ts`.

## 2. Get a test account

If the path isn't `/welcome` or `/login`, the pane may already be signed in, so skip this section. Otherwise use the password `TEST_PASSWORD` from `cypress/support/e2e.ts`. Don't repeat it in chat.

| Step | Do this | Why |
|---|---|---|
| `/welcome` | Click "Create Account" | Goes to `/signup` |
| Password (`#password`) | `form_input`, then check `.value.length` and that `[data-cy="create-account"]` isn't disabled | `computer type` dropped most of the characters here, leaving the button disabled with no error |
| Create Account | Click, then poll for `[data-cy="acknowledge-account-id"]` | Key derivation takes a few seconds |
| Acknowledge checkbox | Click the label text "I've saved my account ID and password together" | `form_input` ticks the DOM but not React's state, so Continue stays disabled |
| Continue | Click, then poll for `#current-password` on `/login` | The account ID is already filled in |
| Login | `form_input` the password, then click Login | |
| Windows Hello prompt | Click "No thanks" | It sits over the page after login |

If you've already used `form_input` on a checkbox, the DOM and React disagree. Two clicks on the label bring them back in step. Check that `continue-button` is enabled before clicking it.

General rule: use `form_input` for password fields and real clicks for checkboxes. `computer type` worked normally in the item Name field. After filling anything that gates a button, confirm the button's state before you click, because a click on a disabled button fails silently.

## 3. Make changes through the UI

`window.mutations`, `window.syncBridge` and the other hooks exist only when `window.Cypress` is set at startup (`src/index.tsx`), so they aren't available here.

- Open a page by clicking its nav item (`page-people`, `page-groups`, `page-topics`, `page-settings`).
- "Add People" (or `fab`) creates the item at once and opens its drawer. The name field is `data-cy="name"`.
- Text fields commit about 1 second after typing stops (`DebouncedTextField`), so an edit doesn't reach the worker the moment you type it.
- Use `find` to get refs, and `browser_batch` for click, type and wait sequences. Take screenshots only for visual proof, because text reads are faster.

## 4. Time sync behaviour

Polls run in the sync worker, so `read_network_requests` doesn't show them. Use two sources and compare timestamps. Both are epoch milliseconds.

**What the user sees:** install this recorder before the action. Polling suits this better than one-off reads, because a state lasting under a second is otherwise missed. It records the chip text too: the aria label is only the headline, so offline reads "Offline" with no count.

```js
window.__t = { at: Date.now(), states: [] }
let last = null
setInterval(() => {
  const el = document.querySelector('[aria-label^="Sync status"]')
  const state = `${el?.getAttribute('aria-label')} | ${el?.textContent}`
  if (state !== last) { last = state; window.__t.states.push([Date.now(), state]) }
}, 50)
```

Set `window.__t.at = Date.now()` just before the action, and read the results with `window.__t.states.map(([t, s]) => [t - window.__t.at, s])`.

**What the server received:** call `preview_logs` with the `api` `serverId`, `search: "incoming request"` and enough `lines`. Each entry has a `time`. Ignore the `OPTIONS` preflights and look for `sync.pollLog` (a push or poll) and `items.putSnapshots` (a snapshot).

Expected timings, online and with a visible tab:

- `pollLog` about 1 second after typing stops
- `putSnapshots` 30 seconds after the last edit
- a regular `pollLog` every 30 seconds

Local round trips are far faster than production, so a state that never appears here may still flash on a real connection. Say so when reporting.

## 5. Simulate offline

The main thread reads `navigator.onLine`, then tells the worker, so override it and fire the event:

```js
Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })
window.dispatchEvent(new Event('offline'))
```

Go back online with:

```js
delete navigator.onLine
window.dispatchEvent(new Event('online'))
```

The sync status changes to Offline within about a second, and on reconnect the queued edit is pushed immediately. This stops the app syncing but doesn't block the network. To exercise failed requests and the degraded state, stopping the `api` server should work, but that hasn't been tried yet.

## 6. Finish up

- Call `preview_stop` for both servers.
- Tell the user about anything left behind. The account and items stay in the dev database on port 8000, so name the account ID.
- Report what you measured and what you couldn't, including any limit of the local setup.
