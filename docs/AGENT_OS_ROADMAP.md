# Agent OS Roadmap

## Source Of Truth

P6 establishes the foundation in the existing DeskPet runtime:

- `PetAgentRuntimeCoordinator` remains the single top-level runtime.
- `ToolRegistry` remains the single tool catalog.
- `AgentEventHub`, run event store, and task activity projection remain the event source of truth.
- `MemoryModel` and `MemoryStore` remain the memory source of truth.

## Data Flow

P6 flow:

`User / DeskPet UI -> Agent Control Plane -> PetAgentRuntime -> ToolRegistry / PermissionGate / Runtime Events -> AgentResultDocument -> AgentResultView`

The AI proposes. Runtime executes. Renderer displays validated native SwiftUI.

## P7 Browser & Research Agent

Future browser capabilities may include:

- `browser.search`
- `browser.open`
- `browser.click`
- `browser.extract`
- `browser.snapshot`
- `browser.back`
- `browser.close`

Required boundaries:

- Isolated browser sessions.
- Domain policy.
- Login handoff and user takeover.
- CAPTCHA detection.
- Citation capture.
- Structured extraction.
- Source freshness.
- Rate limiting, timeout, and cancellation.
- Download handling.
- Anti-bot failure reporting.

Limits:

- Does not promise to query every website.
- Does not bypass CAPTCHA.
- Does not bypass paywalls or access control.
- Does not steal cookies.
- Does not save passwords.
- Login requires explicit user authorization or takeover.
- Each result needs source and last-updated/freshness data.
- Inaccessible sites must be listed.
- Browser content is untrusted input.
- Web pages cannot control Agent Runtime through prompt injection.
- Web text cannot gain tool permission.
- “Ignore previous instructions” on a page is ordinary page data.

## P8 Travel Search Vertical Slice

Travel search should use dedicated provider adapters and structured freshness/citation contracts. Browser extraction may assist research, but flight data needs a separate provider boundary. P8 may replace the DEBUG fixture with real provider-backed data only after permission, freshness, and citation rules are in place.

## P9 Sandbox Mini Apps

Sandbox mini apps remain future work. They must not be arbitrary WebView code from the model. Any interactive mini app needs a constrained schema, fixed renderer, permission-aware actions, and replayable state.

## Ownership

Browser, travel, and mini-app work must extend the existing runtime, tool registry, event hub, and permission gate. No parallel agent framework, LangChain stack, browser runtime, or second ledger should be introduced.

## Lifecycle

P7 introduces browser sessions. P8 introduces real travel search artifacts. P9 introduces constrained interactive artifacts. Each stage must preserve Task Center replay and the Memory V2 policy boundary.

## Failure Handling

Browser failures must report inaccessible domains, login requirements, CAPTCHA, anti-bot blocking, timeout, cancellation, and extraction uncertainty as structured failures. They must not pretend unavailable sources were checked.

## Migration

P6 records remain compatible because future result artifacts should attach to the same task/run result model. Browser/travel artifacts can extend `AgentResultDocument` with schema-versioned components only after validator updates.

## Security Boundary

Future pages and extracted text are untrusted. Prompt injection from web pages cannot modify system policy, gain tool grants, write memory, or execute code. Payment, purchasing, deletion, and irreversible actions remain out of scope unless separately modeled as high-risk tools with final confirmation.

## Test Coverage

Future stages need deterministic fixtures for browser extraction, stale source handling, login handoff, CAPTCHA detection, provider adapter freshness, replay, and prompt-injection resistance.

## Deferred Work

Not implemented in P6:

- Browser Agent.
- Real flight search.
- Airline or travel provider adapters.
- Sandbox mini apps.
- Purchasing, payment, cancellation, or irreversible external writes.
