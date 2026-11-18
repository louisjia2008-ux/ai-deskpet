# P9D Local Discovery Result Presentation

## Scope

P9D turns the P9C Local Discovery terminal checkpoint into user-facing presentation. It does not add search, route, webpage, model, or place-action capability.

Allowed presentation actions are local-only:

- select a place
- switch sort mode
- expand candidate details
- expand evidence
- copy place name
- copy address
- toggle map visibility in compact layout

The UI does not open Maps, start navigation, call phone numbers, open websites, book, buy, create calendar items, create reminders, auto-refresh, or dispatch `PlaceActionDescriptor`.

## Architecture

The presentation path is:

`AgentCheckpoint.domainPayloads["localDiscoveryWorkflow"] -> LocalDiscoveryWorkflowSnapshot -> LocalDiscoveryPresentationAdapter -> LocalDiscoveryPresentation -> SwiftUI`

SwiftUI does not call `ToolRegistry`, MapKit search, route estimation, webpage parsing, verifier code, or checkpoint merge logic. The map only consumes persisted candidate coordinates that the adapter marks valid.

## Result Source Of Truth

The durable source of truth remains the P9C `LocalDiscoveryWorkflowSnapshot` stored under the existing `AgentCheckpoint` domain payload key `localDiscoveryWorkflow`.

The adapter reads:

- `approvedQuery`
- `resolvedLocation`
- `rawCandidates` / `mergedCandidates`
- `validatorFindings`
- `verifierDisposition`
- `rankedCandidateIDs`
- `webpageEvidenceIDs`
- `extractionEvidenceIDs`
- `toolCompletions`
- `backend`
- `warnings`
- `currentStage`
- checkpoint projection state and result document status

No second Local Discovery result store is introduced.

## Presentation State Model

`LocalDiscoveryPresentationStatus` is a single mutually exclusive status:

- preparing
- searching
- routing
- readingEvidence
- verifying
- synthesizing
- complete
- partial
- empty(reason)
- cancelled
- failed(error)

The result view does not compose terminal state from independent booleans such as loading plus cancelled. Cancelled and failed presentations suppress candidate cards and map annotations.

## Candidate Identity

Cards and map annotations use `PlaceCandidate.stableID`. The adapter does not generate `UUID()` during render. Selection is presentation-only and does not mutate `LocalDiscoveryWorkflowSnapshot`, `AgentCheckpoint`, or `AgentResultDocument`.

## Map Behavior

`LocalDiscoveryMapView` renders only candidates with valid coordinates:

- finite latitude and longitude
- latitude in `-90...90`
- longitude in `-180...180`
- horizontal accuracy not above 50 km
- no coordinate-conflict validation finding

Candidates without valid coordinates stay visible in the list and are not replaced with region-center markers. Initial camera fits valid annotations; card or marker selection uses the same candidate ID. User camera movement is transient UI state and is not checkpointed.

## Evidence Semantics

The adapter preserves field state as:

- confirmed
- partial
- unknown
- conflicting
- stale
- notApplicable

Unknown parking stays "停车信息待确认"; unknown price stays "价格信息待确认"; missing route duration stays "未获得路线时间"; straight-line distance is labeled separately from route distance.

User evidence rows show source type, source title, freshness, confidence label, supported field text, and state. Developer diagnostics are opt-in and are kept separate from ordinary evidence display.

## Recovery Behavior

`LocalDiscoveryPresentationStore` loads the existing checkpoint through `AgentCheckpointStore` and rebuilds presentation from `LocalDiscoveryPresentationAdapter`.

Recovery does not call:

- model planner
- model synthesis
- `ToolRegistry`
- `local_place_search`
- `route_distance_estimate`
- MapKit local search
- MapKit route estimation
- webpage read
- structured extraction

Recovered complete, partial, cancelled, and failed states are covered by focused tests. Candidate IDs and evidence mappings are rebuilt from the checkpoint payload.

## Cancellation Behavior

Cancelled checkpoint or cancelled run state becomes `LocalDiscoveryPresentationStatus.cancelled`. The UI shows a terminal cancelled notice, no spinner, no candidate cards, and no map markers. Cancelled is not rendered as failed.

## Accessibility

The result UI includes:

- keyboard-focusable candidate cards
- selected state exposed through accessibility traits
- non-color verification symbols and text labels
- map marker labels
- expand/collapse accessibility labels
- combined card labels with place name, address, distance, route time, opening state, and verification state
- light/dark compatible design-system colors

Long names and addresses wrap or are line-limited with text selection enabled where useful.

## Tests

Focused P9D tests are in `P9DLocalDiscoveryPresentationTests`.

Coverage includes complete, partial, empty, cancelled, failed, unknown parking/price, partial verifier, stale and conflicting evidence, stable IDs, recovery ID stability, coordinate filtering, route/straight-line distinction, sort modes, selection mutability, developer diagnostics separation, and action-dispatch absence.

## App Harness

`P9DLocalDiscoveryPresentationAppSmokeHarness` is DEBUG-only and enabled with:

`DESKPET_P9D_APP_SMOKE_HARNESS=complete|partial|cancel|recovery`

The harness runs inside the real App process after `AppDelegate` creates `ChatModel`, `AgentTaskActivityStore`, and `AgentCheckpointStore`. It installs deterministic terminal checkpoints, loads `chat.localDiscoveryPresentationStore`, renders the SwiftUI result view, captures window screenshots, and writes terminal JSON artifacts.

It records `toolReexecutionCount == 0` and `modelReexecutionCount == 0`; no search, route, model, or external app action is invoked.

## Screenshots

The harness is designed to produce screenshots for:

- complete wide layout
- complete compact/floating-chat-sized layout
- partial result
- evidence expanded
- marker selected
- card selected
- cancelled state
- recovery state
- dark mode
- no-coordinate map state

Screenshots are real App process window captures, not SwiftUI previews.

## Known Limitations

- The harness uses deterministic checkpoint fixtures for presentation smoke coverage; it does not claim live provider, live MapKit, or live route execution for P9D.
- XCUITest is not required for P9D and is not claimed unless separately run.
- The map camera policy is intentionally conservative; outlier clustering beyond bounding-region caps is deferred.
- Copy name/address is local pasteboard only. It is not action dispatch and does not open external apps.

## P9E Boundary

Place Action Dispatch remains a separate gate. Future P9E work may evaluate explicit, approved actions such as opening Maps, starting navigation, opening a website, calling, booking, or reminder/calendar writes. P9D intentionally presents candidates and evidence without dispatching those actions.
