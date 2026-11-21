# QQ Channel Integration Plan — Execution Baseline

This document is the phase-0 baseline for adding a restricted QQ message channel to
the DeskPet Electron agent. It records the fixed security boundary, the permission
matrix, and the phase checklist. The authoritative design discussion lives in the
approved execution plan; this file tracks implementation state.

## Baseline (recorded before any QQ work)

- Working tree: `personal-ai-deskpet-electron-work/electron/` with pre-existing
  uncommitted changes. QQ work must not reset, revert, or overwrite them.
- Regression status at start: `npm test` subsets under `src/main` (170 tests) and
  `npm run test:security` (46 tests) pass. Full `npm run verify` is the phase gate.
- Official QQ Open Platform capability (real private-chat delivery, push limits for
  scheduled results) requires a user-registered bot and is **pending real-account
  verification**. Until then the channel is validated against a mock gateway; the
  adapter interface stays swappable so a NapCat adapter could replace the official
  transport without touching policy code.

## Required boundary (never negotiable from QQ)

QQ-originated runs can never: execute shell/scripts, control keyboard/mouse or
windows, read/write workspace files, read system telemetry, send desktop
notifications, change permissions/providers/plugins/secrets, or read other desktop
sessions. Host code (`src/main/security/`) enforces the tool ceiling; prompt text
does not grant authority. Full acceptance remains pending the checklist below.

## Target permission matrix (policy version 1)

The current candidate declares `cron.create`, `cron.update` and `cron.resume`
only as host-confirmation draft operations. They cannot directly mutate a QQ
schedule. The former code-returning implementation is gone; model tool results
contain only pending/draft identity/expiry. Legacy schedules without a current
process approval remain blocked. This is tested implementation, not complete
release or real-platform acceptance. Desktop Cron retains its approval flow.

| Tool | QQ interactive | QQ-created cron run |
|---|---|---|
| time.current / math.calculate | allow | allow |
| web.search / web.read | allow (bounded per-run budget) | allow |
| task.update / task.list / task.get | allow (own session) | task.update only |
| cron.list / cron.history / cron.pause / cron.cancel | allow (own tasks) | — |
| cron.create / cron.update / cron.resume | allow via host confirmation code | never (no nested cron) |
| workspace.* / system.summary / notification.send / timer.create / history.* | deny | deny |
| anything not in the reviewed allowlist | deny by default | deny by default |

QQ cron capabilities must be a subset of
`['web.search','web.read','math.calculate','time.read']`. Unsupported capabilities
are rejected, not silently removed; `workspace.write` remains desktop-only.

Effective authority = QQ fixed ceiling ∩ desktop QQ settings ∩ bound identity and
session scope ∩ per-operation confirmation ∩ live revocation state. A desktop
"always allow" grant never lifts a QQ denial.

## Data rules (phase 2)

- QQ uses its own chat session per binding; desktop sessions are not attached.
- Memories enter QQ context only when host-confirmed, global-scope, cloud-allowed
  and explicitly marked for QQ use (`qqAllowed`), which no existing memory is by
  default.
- QQ delivery is a distinct disclosure destination: a turn marked `local-only`
  must never be delivered to QQ, and delivery is re-checked at send time.
- QQ replies are delivered only after the complete message passes the disclosure
  gate (no streaming of partial model output to QQ).

## Implemented state and credentials

- QQ configuration, binding, dedup, outbox and confirmation state live in
  `qq-channel-state.enc.json`, encrypted with an independent key in
  `qq-channel-vault/`. Both paths are outside `PROFILE_ROOTS`.
- The AppSecret is stored in that independent `SafeStorageVault` (id
  `qq.app-secret`), NOT the provider `vault/` directory included in backups.
- State carries the profile identity. A different profile resets the binding,
  confirmations and outbox and disables QQ. The desktop restore handler also
  invalidates QQ explicitly, including when restoring the SAME profile identity.
- The earlier development-only plaintext state is not loaded or migrated into
  live authority. It is not deleted automatically. No real credentials were
  supplied during this work.
- Pairing opens a connection while unbound, accepts at most five distinct code
  attempts per code, and produces a candidate identity. Only the console IPC
  can confirm the candidate; possession of the code alone does not bind anyone.
- Stop, unbind, configuration and credential changes synchronously revoke the
  in-memory authority before awaiting writes. Outbox entries carry immutable
  binding/recipient/session/authority stamps. Revoked entries cannot be redirected
  to a new binding. Interrupted sends become `unknown`, not automatic retries.
- Delivery validates the exact completed assistant message, run, current
  recipient and lineage again immediately before the POST. Unknown lineage,
  stale/suppressed/unshared memories and cross-session ancestors are rejected.
- QQ session provenance is stored in the encrypted domain profile. Desktop
  send/retry/follow-up paths cannot upgrade a QQ conversation to desktop authority.

## QQ Cron confirmation and execution candidate (2026-11-03)

- `QqCronCoordinator` freezes the complete normalized parameters, original
  session/provider/model, provider fingerprint, credential reference, exact
  recipient/binding/authority, schedule revision, process identity, permission
  revisions and execution limits. Update/resume cannot switch the original provider.
- The host sends a separate complete JSON summary, digest, expiry and a random
  12-hex-character code. Quoted task text is escaped, hidden control characters
  are rejected/escaped, and an oversized summary fails rather than truncates.
  The code never enters model results or the domain conversation. The confirmation
  record holds its SHA256; the notice containing the code is in the encrypted QQ
  outbox, not plaintext storage or the portable backup.
- A new draft invalidates the old one. Five distinct wrong-code attempts lock the
  draft; it expires after five minutes. Only the bound sender's direct `/confirm`
  command can consume it. The service validates the exact notice and operation,
  then durably consumes confirmation before entering the atomic domain mutation.
  Unknown apply outcomes are not replayed; schedule identity is idempotent.
- Domain transactions recheck session origin, ownership, revision and capacity.
  Plain domain create/update/resume cannot bypass the QQ confirmation route.
  Repeated atomic submission is a no-op, not a revision change or active-run abort.
- Limits: 10 uncancelled QQ tasks (paused tasks count), conservative minimum
  15-minute expression spacing AND actual start separation, 4 model requests per
  run, 2048 output tokens per request, a 120-second cooperative run deadline,
  and the configured web-call limit. Each admitted chat turn or scheduled run
  reserves one unit of the shared daily quota before executing. Missed slots skip.
- Scheduled tool declarations AND execution gates prohibit nested Cron and all
  local/administrative tools. Live approval is checked at reservation, model
  admission/dispatch, tool authorization/execution and result POST. Cancelled,
  paused, updated, rebound or stale runs cannot deliver their old result.
- Permission epochs are process-local. Startup pauses QQ schedules, and old
  process approvals fail closed even if a durable pause fails. Resuming requires
  a new owner confirmation. Desktop schedules are not paused by QQ startup/stop.

## Current UI and validation

- Settings → QQ channel is implemented in Chinese and English: explicit enable,
  independent credentials, provider/model, request/web limits, pairing command,
  candidate confirmation, emergency stop, unbind, clear-secret and failed-send
  retry. Opening the page never enables or pairs a bot. Candidate status is
  refreshed explicitly; no secret or raw upstream error is rendered.
- QQ web reads bypass Crawl4AI and use `SecureWebReader`. The execution-start
  hook charges a web call once; repeated authorization checks do not charge it.
- QQ context excludes desktop speaking-style/consolidation representations in
  addition to the memory opt-in filter.
- Official Identify format was checked against the current official docs:
  `QQBot {AccessToken}`, not `QQBot {AppID}.{AccessToken}`. Gateway targets are
  restricted to reviewed QQ HTTPS/WSS service hosts, event/response sizes are
  bounded, redirects are rejected, and old connection callbacks are generation-
  isolated. The candidate now captures session/sequence, resumes including replay
  before RESUMED, handles Invalid Session, requested heartbeats, missing ACK and
  handshake timeout, and backs off with jitter (cap 30 seconds, 8 retries).
  Only a connection stable for 60 seconds resets backoff; stop cancels timers and
  in-flight discovery. Real-platform behavior remains unverified.
  Reference: https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
- Actual portable backup archives are tested to exclude `qq-channel-state.enc.json`
  and `qq-channel-vault/`, including their key and AppSecret. Domain conversation
  provenance and QQ schedule metadata remain part of the encrypted profile; they
  do not restore live QQ authority. Same-profile restore still explicitly unbinds.
- Pre-rebuild baseline only: 146 files passed, 1 skipped; 1,558 tests passed,
  1 skipped. Do not use that count as validation of the new Cron implementation.
- Final code-candidate validation (2026-11-03): `npm run typecheck` PASS;
  `npm test` 148 files passed, 1 skipped / 1,636 tests passed, 1 skipped;
  `npm run test:security` 10 files / 55 tests passed; ESLint over the changed
  QQ/Cron/provider-boundary/backup-test/UI/shared files PASS; tracked diff
  whitespace check PASS.
- New adversarial coverage includes real encrypted channel/domain persistence,
  create/update/resume, duplicate/concurrent confirmation, five guesses/expiry,
  summary/digest mismatch, unsent notices, unknown POST/apply outcomes, failed
  writes, process restart, provider/credential changes, cross-owner scope,
  queued revision/permission races, capacity races, actual interval spacing,
  per-run model/token/time limits, local-tool/nested-Cron denial, result-delivery
  invalidation, reconnect lifecycle and portable-archive exclusion.
- The earlier full `npm run lint` run failed with 1,527 errors in the former Minecraft engine
  JavaScript files; no `src/` or `tests/security/` errors in that run. The QQ work
  does not change or suppress these unrelated lint rules/findings. Per the user's
  scope, Minecraft and the full `npm run verify` release gate were not run again.
- The isolated package and development E2E results are recorded separately below.
  The daily app was installed and committed with the 2026-11-03 chat batch, default
  off; there has been no real login or push. Real QQ acceptance and the complete
  release gate remain open.

## Isolated package and E2E evidence (2026-11-03)

Paths in this section are relative to the workspace root, not `electron/`.

- Candidate root: `output/deskpet-qq-candidate-20261103-r1/`.
  Exact app: `package/DeskPet Electron Candidate-darwin-arm64/DeskPet Electron Candidate.app`
  beneath that root. `package-receipt.json` records its identity and limitations.
- Generated with Forge's `api.package` in `validation-candidate` mode and an
  independent output directory. Existing staged Minecraft resources and the
  existing migration helper were reused; neither preprocessing step was run.
  No Swift-native source or Minecraft checks were changed.
- Exact-target `audit:package` PASS (one ASAR, existing exclusions unchanged).
  `codesign --verify --deep --strict` PASS for the ad-hoc-signed candidate; this
  is not Developer ID signing, notarization or release acceptance.
  ASAR SHA256: `428c8a72c2f7c6c4d3d782226055526f365c1b328ad04ba7f69b70504ecd9131`.
- **Packaged E2E BLOCKED, not passed:** Electron launch timed out before the QQ
  flow. A separately launched isolated candidate was sampled; its main thread
  waited in macOS Keychain `SecItemCopyMatching` / `SecKeychainItemCopyContent`.
  Evidence: `startup-diagnostic/main-process.sample.txt` and the original
  `playwright/` failure trace. Only the diagnostic's own process was terminated.
  No Keychain permissions were changed and no packaged safeStorage replacement
  or product test backdoor was introduced. Further platform authorization needs
  the user's explicit involvement.
- **Development E2E PASS:** `tests/e2e/qq-channel.spec.ts`, third run, one test
  passed (4.5 seconds total). Evidence: `evidence-dev-r3/acceptance.json`,
  `qq-en-stopped.png`, `qq-zh-disabled.png` and `playwright-dev-r3/`.
  The receipt explicitly says `development-bundle`,
  `standard-Playwright-test-keychain` and `realQqVerified: false`.
- The development run uses real renderer/preload/IPC, host policy, provider
  utility, encrypted persistence and normal restart; only the QQ transport and
  model network responses are synthetic. It covers default-off behavior,
  narrow preload/overlay denial, explicit secret save, desktop-finalized pairing,
  separate host Cron summary, no confirmation code in model requests, direct
  single-use confirmation, undeclared local-write rejection, emergency-stop
  cancellation/no late reply, encrypted state, restart, unbind, clear-secret and
  Chinese/English settings. It does **not** execute a due Cron task or prove real
  proactive push. Restart happens after emergency stop, so this scenario alone
  does not establish enabled-at-startup pause behavior (covered in lower-level tests).
- `evidence-dev-r3/artifact-comparison.json` records matching development and
  candidate main/utility bundle hashes and confirms the ASAR still matches the
  package receipt. Matching bundles do not make the development run a packaged
  Keychain or packaged E2E pass.
- Earlier development failures remain in `playwright-dev-r1/` and
  `playwright-dev-r2/`. Fixes were confined to the E2E fixture: the provider's
  accessible label includes its options, and model tool names are encoded wire
  names rather than runtime ids. Product permission checks were not weakened.
- After the fixture fixes: `npm run typecheck` PASS; ESLint for the E2E and
  package-audit scripts PASS; `node --test scripts/audit-package.test.mjs`
  two tests PASS. The optional audit target retains the default `out/` behavior
  and existing forbidden-content checks. No product source changed after the
  full code-candidate regression recorded above.

## Phase checklist

- [x] Phase 0 — baseline, boundary, matrix, this document.
- [ ] Phase 1 — final acceptance of execution-context + channel-policy enforcement
      (core gates and regression tests implemented; end-to-end review pending).
- [ ] Phase 2 — QQ memory gate, remote-destination treatment, disclosure policy
      for outbound replies.
- [ ] Phase 3 — channel service: official WebSocket adapter (transport-abstracted),
      inbox dedup, durable outbox, pairing/binding, narrow host entry.
- [ ] Phase 4 — per-run web budget + adapter URL/target constraints test coverage.
- [ ] Phase 5 — QQ cron: confirmation flow, channel-aware schedules, scoped
      execution, result delivery, unbind/stop propagation.
- [ ] Phase 6 — console QQ settings page, emergency stop, IPC surface.
- [ ] Phase 7 — security test matrix, docs, full `npm run verify` gate.

Real-account acceptance (live QQ round trip, cron push, reconnect) remains a
user-assisted step and is tracked as pending, not as a code phase.

## Secondary-account transport (2026-11-03)

`QqTransportRouter` selects the official adapter or `QqOneBotAdapter`; see
`QQ_ONEBOT_SETUP.md`. Tested against a real local WebSocket with a synthetic NapCat
(`tests/e2e/qq-onebot.spec.ts`). A real NapCat login and QQ round trip remain pending.

## Next implementation gate

1. With the user's explicit involvement, resolve the platform Keychain startup
   authorization and rerun the QQ E2E against the exact packaged candidate in a
   fresh isolated profile. Do not substitute development/test storage results.
2. Exercise official private-chat delivery, host-summary delivery, confirmation,
   scheduled proactive push limits and reconnect/resume with a real registered bot.
   Enter credentials only in the desktop settings; never send them in this chat.
3. Keep the complete release gate open. The existing package audit and passing
   development E2E are not full release acceptance. Minecraft changes/check
   relaxation and Swift-native edits remain outside this round.
