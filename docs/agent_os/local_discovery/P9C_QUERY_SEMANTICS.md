# P9C Query Semantics

## Intent Decision

`LocalDiscoveryIntentDecision` contains:

- `isLocalDiscovery`
- `confidence`
- `requestedCategory`
- `explicitLocation`
- `requiresLocationPermission`
- `unsupportedRequirements`
- `routingReason`
- `requestKind`

The classifier distinguishes local discovery from plain knowledge questions, known-place detail lookup, route-only requests, product-store discovery, and complex browser tasks.

## PlaceQuery Planner

`LocalDiscoveryQueryPlanner` produces the P9B `PlaceQuery` contract and a wrapper `LocalDiscoveryPlannedQuery` containing assumptions, missing information, unsupported requirements, and deterministic fallback metadata.

Closeout adds `LocalDiscoveryModelStructuredPlanner` as the primary production planner when an eligible provider is available. It is created by `AIServices` through the existing provider store, `ModelRouter`, persisted `ModelConformanceProfile`, and generic `LLMClient`. It receives the original user message, relevant conversation context, injected current date/time, locale, timezone, available capabilities, permission summary, search policy, and the PlaceQuery draft JSON schema. It does not receive API keys, raw reasoning, unrelated memory, unrestricted tool execution, or place-provider facts.

The model draft must contain:

- `isLocalDiscovery`
- `searchText`
- `category`
- `locationInput`
- `temporalConstraint`
- `hardConstraints`
- `softPreferences`
- `budget`
- `travelLimit`
- `resultLimit`
- `assumptions`
- `missingInformation`
- `unsupportedRequirements`

Drafts are rejected when they add merchant/candidate facts such as business names, addresses, coordinates, phones, opening hours, prices, parking, or arbitrary reasoning fields.

Provider-compatible normalization is deterministic and field-scoped:

- Category aliases such as `Sichuan Restaurants` are canonicalized to supported `PlaceCategory` values.
- A preserved explicit location label with `unknown` location kind is promoted to `explicitRegion`; an explicit location downgraded to current location is still rejected.
- Missing-information placeholders such as `None` are ignored.
- Unrequested optional gaps such as party size, ambiance, takeout, spice tolerance, or budget/time preferences are not blocking clarification.
- User-requested hard gaps, unsupported live inventory, contradictory budgets, and missing category/location remain blocking.

## Schema, Repair, And Fallback

Planner execution is bounded:

- Structured output is validated with `ToolSchemaValidator`.
- Drafts are normalized into the P9B `PlaceQuery` contract.
- Semantic validation rejects unsupported inventory overclaim, contradictory budgets, invalid enum values, explicit-location downgrades to current location, and hard/soft parking confusion.
- Repair uses structured validation errors only, for at most two rounds and within the conformance profile autonomous-step limit.
- If repair is exhausted, deterministic fallback is allowed only for safe simple requests such as `Sichuan restaurant in San Francisco`, `golf driving range near San Jose`, or `coffee shop within 5 miles`.
- Complex failures become clarification requests rather than guessed hard constraints.

## Location Priority

1. Explicit user location such as San Francisco, San Jose, UCLA, Los Angeles, or a ZIP code.
2. Conversation context when present.
3. Approximate current location when the user says nearby and has not supplied a location.
4. User clarification with city, ZIP, or landmark.

Explicit region search does not request current location permission.

## Time

The planner uses injected `Date`, `Locale`, and `TimeZone`.

Current deterministic mappings:

- now -> target `now`, `openNow = true`
- tonight -> 20:00 local time
- tonight/open late -> 21:00 local time
- tomorrow morning -> 09:00 next day
- noon -> 12:00 same day
- Saturday afternoon -> next Saturday 15:00
- after midnight -> next day 00:30

If target-time opening cannot be proven by evidence, validator leaves opening as unknown/partial.

## Budget

- `人均 40 美元以内` maps to `PlaceBudget(maximumAmount: 40, perPerson: true)` and a hard `priceMaximum`.
- `总预算 100 美元` maps to `perPerson: false`.
- `便宜一点` and `价格不要太高` remain soft preferences.
- `$$` remains a soft price-level preference unless a hard amount is present.

## Distance

- `开车 20 分钟以内` maps to hard `travelTimeMaximum`.
- `步行 10 分钟` maps to walking travel time.
- `5 英里以内` maps to hard `distanceMaximum`.
- `附近` uses `LocalDiscoverySearchPolicy.defaultRadiusMeters` and records an assumption.

Route distance and straight-line distance are separate fields.

## Unsupported Requirements

Product-store requests such as USB-C charger discovery are allowed as store discovery, but `live_inventory` is marked unsupported. Final synthesis must say possible availability only, not real inventory.

## Conformance Routing

Persisted `ModelConformanceProfile` gates the planner role. A provider that is forbidden for role `planner`, lacks usable structured output, has unreliable reasoning separation, or has insufficient autonomous-step budget cannot silently become the primary planner. The workflow then uses deterministic fallback or asks for clarification.

Final closeout live probe used MiniMax-M3 through `ModelRouter` and persisted conformance profile. The accepted draft validated as `ready`, used `sichuan_restaurant`, preserved San Francisco as `explicitRegion`, required 0 repair rounds, and did not use deterministic fallback.
