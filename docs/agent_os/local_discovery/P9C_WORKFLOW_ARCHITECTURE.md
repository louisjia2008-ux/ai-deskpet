# P9C Local Discovery Workflow Architecture

## Status

P9C introduces a Local Discovery workflow branch inside the existing DeskPet agent runtime. It is not a second runtime.

Current closeout status: complete for P9C. The natural-language workflow, model structured planner path, bounded repair loop, versioned workflow snapshot, completed-step skip logic, full-stage cancellation, live workflow probes, and DEBUG real App complete/cancel smoke harness all reached terminal evidence.

## Production Path

The workflow reuses the existing main chain:

`PetAgentRuntimeCoordinator -> RuntimeRequestPreparer -> LocalDiscoveryWorkflow -> ModelRouter/LLMClient when available -> ToolCatalogProviding/ToolPlatformExecuting -> ToolRegistry -> CapabilityGate/SystemAuthorization -> Runtime Activity/Evidence/AgentCheckpointStore/AgentResultDocument`

The coordinator creates the same task/run ledger entries as other agent tasks, then dispatches to `LocalDiscoveryWorkflow` only when `RuntimeRequestPreparer` returns `executionMode == .localDiscoveryWorkflow`.

## Workflow Graph

1. `classifyIntent`
2. `buildQuery`
3. `resolveLocation`
4. `searchCandidates`
5. `deduplicateCandidates`
6. `estimateDistances`
7. `selectEnrichmentTargets`
8. `enrichCandidates`
9. `validateCandidates`
10. `genericVerifier`
11. `rankCandidates`
12. `synthesizeResult`

## Reused Components

- `PetAgentRuntimeCoordinator`
- `RuntimeRequestPreparer`
- `ToolRegistry`
- `CapabilityGate`
- `SystemAuthorizationProviding`
- `AgentTaskActivityEvent`
- `AgentEvidenceRecord`
- `LocalDiscoveryValidator`
- `AgentResultDocument`
- `PlaceCandidateDeduplicator`

## New Components

- `LocalDiscoveryIntentDecision`
- `LocalDiscoveryIntentClassifier`
- `LocalDiscoveryQueryPlanner`
- `LocalDiscoveryModelStructuredPlanner`
- `LocalDiscoveryPlaceQueryDraftNormalizer`
- `LocalDiscoverySearchPolicy`
- `LocalDiscoveryWorkflow`
- `LocalDiscoveryWorkflowSnapshot`
- `LocalDiscoveryWorkflowVerifier`

## Planner Path

The primary closeout planner is `LocalDiscoveryModelStructuredPlanner`. `AIServices` creates it through the existing `ModelRouter`, `ProviderStore`, persisted `ModelConformanceProfile`, and `LLMClient` factory. The workflow never calls a concrete provider client directly.

Planner execution order:

1. Select a planner-capable model through `ModelRouter`.
2. Apply persisted conformance restrictions for role `planner`.
3. Request strict JSON matching the additive PlaceQuery draft schema.
4. Validate with `ToolSchemaValidator`.
5. Normalize deterministically into the P9B `PlaceQuery` contract.
6. Run semantic validation for hard/soft, location, budget, time, and unsupported requirement safety.
7. Repair at most two rounds, bounded by `ModelConformanceProfile.maxAutonomousSteps`.
8. Fall back to deterministic planning only when the model path is unavailable or safe simple-query fallback applies.

The model is not allowed to output `PlaceCandidate`, merchant names, opening hours, prices, phone numbers, coordinates, or other tool facts.

Closeout note: live MiniMax planner output exposed provider-compatible draft variations such as natural-language category aliases, explicit location labels with `unknown` kind, and optional preference gaps listed as missing information. `LocalDiscoveryPlaceQueryDraftNormalizer` now canonicalizes supported category aliases, promotes preserved explicit location labels to `explicitRegion`, and filters only unrequested optional preference gaps. It still repairs or clarifies true missing category/location, explicit-location downgrades, unsupported inventory claims, and contradictory hard constraints.

## Durable Snapshot

P9C stores `LocalDiscoveryWorkflowSnapshot` as the additive domain payload key `localDiscoveryWorkflow` inside the existing `AgentCheckpoint`. No second checkpoint store exists.

The snapshot records schema version, task/run/workflow IDs, current stage, approved query, resolved location, search policy, raw and merged candidates, completed/pending route candidate IDs, completed/pending enrichment candidate IDs, webpage and extraction evidence IDs, validator findings, verifier disposition, ranked candidate IDs, synthesized revision, tool completion identities, last applied checkpoint sequence, and update time.

Recovery rules:

- Terminal `cancelled` and `resultSynthesized` snapshots do not resume.
- Corrupted domain snapshots return an explicit `recoveryBlocked` outcome rather than replaying unsafe network steps.
- Completed `local_place_search`, route candidates, enrichment URLs, and validation outputs are skipped by stable candidate IDs and tool completion identity.
- Evidence IDs and stable candidate IDs are preserved from the snapshot.

## Read-Only Boundary

The workflow dispatches only the P9B read-only tools:

- `approximate_location`
- `local_place_search`
- `route_distance_estimate`
- `webpage_read`
- `structured_place_extraction`

`PlaceActionDescriptor` values may remain attached to candidates, but P9C does not dispatch actions.

## Known Limitations

- The deterministic planner remains a conservative fallback and handles only safe simple cases when the model path is unavailable or exhausted.
- Explicit-region coordinates use known region centroids for route origin when available. Search itself uses `regionText`.
- P9C still uses the existing generic `AgentResultDocument` display. Final map/card UI and Place Action Dispatch are intentionally deferred to later phases.
- XCUITest was not claimed. Product smoke evidence comes from the DEBUG real App process harness with screenshots, traces, checkpoint, and ledger artifacts.
