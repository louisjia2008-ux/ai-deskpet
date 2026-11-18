# P9E Explicit Place Handoff Actions

## Scope

P9E adds explicit, user-confirmed handoff actions for Local Discovery place candidates. It does not redesign P9C workflow or P9D presentation, and it does not add a second durable Local Discovery result source.

Allowed actions:

- `place.openInMaps`
- `place.openDirections`
- `place.openOfficialWebsite`
- `place.startPhoneHandoff`

Out of scope: booking, ordering, purchasing, payment, form filling, login, email, SMS, merchant chat, calendar/reminder writes, favorites mutation, continuous navigation, background refresh, background monitoring, or Computer Use automation of external apps.

## Action Taxonomy

`PlaceHandoffActionKind` is a closed enum. `PlaceHandoffRequest` carries a stable request ID, task/run IDs, candidate ID, action kind, typed destination, evidence state, and timestamp. Destinations are strongly typed as map place, directions, website, or phone; SwiftUI never builds the final URL.

## Explicit User Initiation

Actions are only created from candidate-card button activation. Selection changes, marker clicks, result arrival, model suggestions, tool output, webpage content, hover, and recovery events do not call `prepare`, `confirm`, or `dispatch`.

## Eligibility Policy

`PlaceHandoffEligibilityEvaluator` evaluates every action before preview:

- Maps require a legal coordinate or specific address.
- Directions require a legal destination and explicit origin policy.
- Website requires official/canonical http or https URL with valid host and no credentials.
- Phone requires a normalized dialable number and blocks conflicts, USSD, pause/wait sequences, and invalid content.

Unavailable actions expose blocking reasons in the candidate card, accessibility hint, and tooltip.

## Evidence Policy

`PlaceActionEvidenceState` distinguishes confirmed, supported, partial, stale, conflicting, and unknown data. Partial and stale actions may proceed with warnings where policy permits. Conflicting directions, website, and phone values are blocked. Business-hours freshness does not drive action availability and is not used to claim that a handoff target is currently open.

## Confirmation Model

Every action opens an immutable preview first. Confirmation buttons use concrete verbs:

- 在地图中打开
- 查看路线
- 打开网站
- 拨打电话

Cancel is always visible. Closing the confirmation sheet is treated as cancel before dispatch. A terminal request cannot be confirmed again; retry creates a new attempt ID.

## Permission Model

`DefaultPlaceHandoffAuthorizer` checks registered capability IDs and the injected `SystemAuthorizationProviding` seam after the explicit preview confirmation. P9E does not add broad "always allow all places/websites/phones" grants.

## System Dispatcher Boundary

`PlaceHandoffDispatching` is the only system handoff boundary. `SystemPlaceHandoffDispatcher` uses MapKit/NSWorkspace/tel only inside the adapter. Tests and DEBUG harness inject fake dispatchers. The adapter returns "accepted by system" or failure semantics only.

## URL Security

`PlaceHandoffURLValidator` allowlists only `http` and `https`, requires a host, rejects credentials, control characters, percent-encoded forbidden schemes, empty hosts, excessive length, and unknown/custom schemes. It warns on http, Unicode host risk, punycode, suspicious ports, redirectors, and stripped tracking/sensitive query fields. Audit summaries remove credentials, query, and fragments.

## Phone Security

`PlacePhoneNumberValidator` normalizes international and US numbers, maps vanity numbers with warning, strips extension suffixes with manual-entry warning, rejects USSD/service codes, `telprompt:`, URL-like strings, pause/wait characters, script content, invalid characters, and excessive length. P9E does not auto-dial extensions.

## Location Privacy

Directions origin is explicit: current location, last known location, user-entered address, or none. Preview shows "当前位置" without precise coordinates. Audit summarizes origin class only and does not retain precise origin history.

## Idempotency

Request IDs are stable over task ID, run ID, candidate ID, action kind, and sanitized destination summary. Dispatch runs once per attempt. Fast repeat confirmation increments duplicate count but does not re-dispatch. Retry creates a new attempt ID tied to the same request.

## Cancellation

Preview cancel and sheet close cancel before dispatch. Permission cancellation does not dispatch. Dispatcher checks task cancellation before submitting to the system. Once the system accepts a handoff, DeskPet reports handed-off and does not claim it can retract the external operation.

## Recovery

Recovered previewing/awaiting-confirmation records become cancelled with "上次操作未执行". Recovered dispatching records become interrupted and are not re-executed. Handed-off, rejected, cancelled, failed, and interrupted records remain terminal.

## Audit Redaction

`PlaceHandoffExecutionRecord` stores action kind, candidate ID, request/attempt IDs, timestamps, user initiation, permission decision, dispatch result, terminal state, and sanitized destination summary. It does not store API keys, authorization headers, cookies, full webpage content, browser history, sensitive URL query/fragment data, or phone communication outcome.

## Tests

Focused P9E tests cover eligibility, URL and phone validation, explicit preview, confirmation, permission denial/cancel, duplicate dispatch, fake dispatcher status mapping, audit redaction, and recovery without re-execution.

Regression gates remain P9D presentation, P9C workflow, capability/permission/checkpoint/ChatModel suites, full SwiftPM, Xcode project generation/list, Debug build, and real App-process DEBUG harness.

## App Harness

`DESKPET_P9E_APP_SMOKE_HARNESS` supports:

- `mapsAccepted`
- `directionsDenied`
- `websiteBlocked`
- `phoneCancelled`
- `handedOffRecovery`
- `interruptedRecovery`

The harness installs fixture checkpoints, loads presentation through `ChatModel.localDiscoveryPresentationStore`, injects fake authorizer/dispatcher into `ChatModel.placeHandoffViewModel`, captures real App-process screenshots, and writes JSON artifacts. `externalApplicationActuallyOpened` must remain false.

## Screenshots

The harness captures candidate action row, map preview, directions warning, website security warning, phone confirmation, permission denied, handed-off terminal, cancelled terminal, interrupted recovery, narrow Floating Chat actions, wide result card actions, and dark mode across the scenario set.

## Known Limitations

P9E does not verify that the external Maps app, browser, or phone handler completed any user-visible workflow. A successful dispatch means only that the system accepted the handoff request.

## Future High-Risk Gate

Booking, purchase, payment, login, form submission, messaging, email/SMS, merchant contact, calendar/reminder writes, long-running location sharing, and background monitoring require a separate high-risk gate with narrower permissions, stronger audit, and dedicated user consent.
