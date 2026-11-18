# P9C Acceptance Plan

## Fixture Coverage

Run:

```bash
env SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-p9c-module-cache CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-p9c-clang-cache swift test --scratch-path /private/tmp/deskpet-p9c-swiftpm-scratch --filter P9CLocalDiscoveryWorkflowTests
```

Expected coverage:

- Intent classification
- RuntimeRequestPreparer workflow routing
- Model structured planner schema validation and bounded repair
- Deterministic planner fallback for safe simple queries
- Conformance role restriction
- Query planner hard/soft semantics
- Explicit location skips approximate-location permission
- Nearby denied location awaits user input and does not search
- Search -> dedup -> route -> enrichment -> validator -> verifier -> result
- Straight-line fallback is not overclaimed as driving route
- Cross-instance workflow recovery skips completed search, route candidates, enrichment URLs, validation, and cancelled terminal tasks
- Cancellation covers planner, location, search, route, webpage, extraction, validator, verifier, and synthesis barriers
- Activity reducer projects Local Discovery tool lifecycle

## Live Workflow Probe

Run:

```bash
env DESKPET_P9C_LIVE_WORKFLOW_PROBE=1 SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/deskpet-p9c-module-cache CLANG_MODULE_CACHE_PATH=/private/tmp/deskpet-p9c-clang-cache swift test --scratch-path /private/tmp/deskpet-p9c-swiftpm-scratch --filter P9CLocalDiscoveryLiveWorkflowProbeTests
```

Expected coverage:

- Natural-language Sichuan restaurant request
- Natural-language golf driving range request
- Same P9C workflow for both categories
- Real release `ToolRegistry`
- Real `local_place_search`
- Route estimates when candidates exist
- Webpage enrichment when candidate URLs exist
- Validator and generic verifier
- Structured `AgentResultDocument`

## Live Structured Planner Probe

Run:

```bash
env DESKPET_P9C_LIVE_STRUCTURED_PLANNER_PROBE=1 swift test --filter P9CLocalDiscoveryLiveWorkflowProbeTests/testLiveMiniMaxStructuredPlannerUsesModelRouterAndConformanceWhenEnabled
```

Expected coverage:

- `ProviderStore` and `ModelConformanceProfileStore` are isolated to a temp root.
- `ModelRouter` routes the `.tool` role with persisted planner conformance.
- `ProviderClientFactory` creates the real adapter.
- `LocalDiscoveryModelStructuredPlanner` emits a PlaceQuery draft only; no candidates or merchant facts.
- Schema validation, deterministic normalization, and semantic validation succeed.
- The accepted result is `ready` and `usedDeterministicFallback == false`.

## Regression

Run:

- P9C focused tests
- P9B domain/tool/capability tests
- provider structured output/streaming tests
- model conformance tests
- recovery tests
- event/state/cancellation tests
- permission tests
- activity tests
- full `swift test`
- `xcodegen generate`
- `xcodebuild -list`
- Xcode build
- GUI/product smoke
- `git diff --check`

## Real App GUI Smoke

The smoke must launch the app, send a Local Discovery chat request through the real chat entry, verify Activity/search/route/enrichment/verification visibility, final structured result, terminal collapse, old-task isolation, Floating Chat/Task Center same task/run identity, and Stop behavior.

If XCUITest automation blocks, a DEBUG real App process harness is acceptable only when it goes through AppDelegate, ChatModel, scheduler, runtime, ToolRegistry, ActivityStore, checkpoints, and AgentResult artifacts. Runtime fixture evidence alone is not GUI PASS.

Final P9C closeout uses the DEBUG real App process harness. XCUITest is not reported as PASS.
