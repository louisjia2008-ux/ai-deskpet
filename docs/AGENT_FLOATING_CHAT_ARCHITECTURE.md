# DeskPet Floating Chat Architecture

## 1. Product Goal

The goal is to release everyday companion chat from the control panel and make
it available as a lightweight desktop surface.

```text
把聊天入口从控制面板中释放出来，变成桌面上的轻量浮动 companion chat。
它默认弱存在，不打扰用户。
用户点击、按快捷键或宠物触发时展开。
它是 Agent Loop 的可视化入口，但不是第二套 Agent Runtime。
```

The floating chat is a companion interface. It should feel attached to the pet,
not like a generic automation console. Its first version should be stable,
small, testable, and conservative about focus and permissions.

## 2. Non-goals for P1

P1 does not implement:

- complete subagent execution
- MCP integration
- automatic shell execution
- automatic source-code modification
- automatic email sending
- file deletion
- unrestricted filesystem access
- autonomous background tasks
- default automatic OpenAI usage
- infinite or unrestricted recursive agents
- full provider-routing UI
- real billing enforcement
- moving the whole control panel into the floating chat
- a second agent runtime
- a second provider router
- a second permission gate

## 3. UI State Machine

P1 should introduce the UI state explicitly:

```swift
enum FloatingChatVisibilityState {
    case hidden
    case capsuleIdle
    case capsuleActive
    case expanded
    case taskHUD
}
```

State meanings:

- `hidden`: feature is disabled or explicitly hidden.
- `capsuleIdle`: weak desktop presence; low visual weight.
- `capsuleActive`: clickable capsule; used for hover, notification, unread
  reply, or pet-triggered invitation.
- `expanded`: full chat panel with composer and message list.
- `taskHUD`: compact task/agent progress surface.

Transition table:

| Current State | Event | Next State | Side Effect |
| --- | --- | --- | --- |
| `hidden` | app launch and feature disabled | `hidden` | Do not create visible panel. |
| `hidden` | app launch and feature enabled | `capsuleIdle` | Create panel in capsule size, low opacity. |
| `capsuleIdle` | user clicks pet | `expanded` | Ask panel controller to expand near pet or safe screen edge. |
| `capsuleIdle` | user clicks capsule, if hit testing is enabled | `expanded` | Make panel interactive and focus composer. |
| `capsuleIdle` | user presses chat hotkey | `expanded` | Show panel; focus composer only after explicit shortcut. |
| `capsuleIdle` | mouse approaches capsule or unread notification arrives | `capsuleActive` | Increase opacity and enable click target. |
| `capsuleActive` | mouse leaves and no unread/task state | `capsuleIdle` | Reduce opacity and optionally ignore mouse events. |
| `capsuleActive` | user clicks capsule | `expanded` | Make panel key-capable and focus composer. |
| `capsuleActive` | user presses chat hotkey | `expanded` | Expand and focus composer. |
| `expanded` | user sends message | `expanded` | Call `ChatModel.send(...)`; clear draft; show pending message. |
| `expanded` | model starts responding | `expanded` | Keep composer visible; show busy/stop state. |
| `expanded` | agent requires approval | `expanded` | Show approval card; do not execute action automatically. |
| `expanded` | inactivity timeout and no pending approval | `capsuleIdle` | Collapse; keep conversation state in shared `ChatModel`. |
| `expanded` | user presses Esc | `capsuleIdle` | Collapse without cancelling active generation unless user explicitly stops. |
| `expanded` | user disables floating chat | `hidden` | Close/order out panel; leave runtime untouched. |
| `taskHUD` | task completes | `capsuleActive` | Show completion affordance or unread indicator. |
| `taskHUD` | user clicks HUD | `expanded` | Open timeline/details in expanded panel. |
| `taskHUD` | inactivity timeout after terminal state | `capsuleIdle` | Collapse to weak presence. |
| any visible state | user disables floating chat | `hidden` | Hide panel; remove hit target. |

P1 should not invent runtime states in the UI. Runtime/task state should be
derived from `ChatModel` and future runtime output projections.

## 4. Hit Testing / Focus Rules

`capsuleIdle`:

- low opacity
- minimal size
- may set panel/window `ignoresMouseEvents = true`
- should avoid blocking normal desktop/app clicks
- should not become key

`capsuleActive`:

- used for hover, unread reply, or pet-triggered invitation
- may accept mouse clicks
- should still avoid stealing focus until the user clicks or presses shortcut
- should be easy to dismiss by timeout or mouse leave

`expanded`:

- accepts keyboard input
- can become key window/panel
- focuses the composer only after explicit user action
- should keep a clear collapse affordance and Esc handling
- should not activate dangerous actions automatically

`taskHUD`:

- shows visible task/progress state
- default should not steal focus
- clicking it can expand into details
- approval-required status can request attention, but cannot execute actions

Approval card rule:
An approval card may proactively expand the panel when the runtime emits a
waiting-for-approval state. The approval UI is a decision surface only. The
actual effect still requires `CapabilityPermissionGate` / `ToolRegistry`.

## 5. Proposed P1 File Plan

### New Files

`Sources/DeskPet/FloatingChat/FloatingChatVisibilityState.swift`

Responsibility:
Define `FloatingChatVisibilityState` and small pure transition helpers if
needed.

Dependencies:
Foundation only, or no imports.

Must not do:
No AppKit, SwiftUI, runtime calls, provider calls, or side effects.

`Sources/DeskPet/FloatingChat/FloatingChatStateStore.swift`

Responsibility:
Own floating chat UI state: visibility, hover/active state, inactivity
deadline, unread marker, and optional last task summary.

Dependencies:
SwiftUI/Combine or Observation, plus Foundation.

Must not do:
No `NSPanel` creation, no `ChatModel.send`, no provider client calls, no tool
execution.

`Sources/DeskPet/FloatingChat/FloatingChatPanelController.swift`

Responsibility:
Create and own the `NSPanel`, configure AppKit window behavior, resize/reposition
for capsule/expanded/HUD states, and expose narrow commands such as `show`,
`expand`, `collapse`, `hide`, and `toggle`.

Dependencies:
AppKit, SwiftUI hosting, `FloatingChatStateStore`, shared `ChatModel`,
`ProviderStore` or a view model adapter.

Must not do:
No runtime bootstrapping, no tool invocation, no provider routing logic, no
business state beyond panel lifecycle.

`Sources/DeskPet/FloatingChat/FloatingChatWindowView.swift`

Responsibility:
Switch between capsule, expanded chat, and task HUD views based on
`FloatingChatStateStore`.

Dependencies:
SwiftUI, floating chat store, shared chat adapter/view model.

Must not do:
No direct AppKit window mutation, no provider client calls, no tool calls.

`Sources/DeskPet/FloatingChat/ChatCapsuleView.swift`

Responsibility:
Render the weak desktop capsule, unread indicator, and model badge in compact
form.

Dependencies:
SwiftUI and display-only view state.

Must not do:
No text generation, no runtime calls, no settings UI.

`Sources/DeskPet/FloatingChat/ChatExpandedView.swift`

Responsibility:
Render the expanded message list/composer using the shared chat model path.

Dependencies:
SwiftUI and a shared chat adapter/view model.

Must not do:
No duplicated conversation storage and no direct provider/tool execution.

### Minimal Modified Files

`Sources/DeskPet/AppDelegate.swift`

Responsibility:
Instantiate `FloatingChatPanelController` after `ChatModel`, `ProviderStore`,
and runtime dependencies already exist. Wire menu/hotkey/pet callbacks to the
controller.

Must not do:
Do not create a second `AgentRuntimeContainer` or second `ChatModel`.

`Sources/DeskPet/Input/HotKeys.swift`

Responsibility:
Expose a floating-chat toggle callback or reuse the current quick-chat callback
for P1.

Must not do:
Do not implement true global hotkey registration in P1 unless separately
scoped. Do not observe/log arbitrary keystrokes.

### Optional but Cautious

`Sources/DeskPet/Window/OverlayWindowController.swift`

Responsibility:
Expose a narrow pet-click/chat-request callback if pet interaction should expand
the floating chat.

Must not do:
Do not own the floating panel, chat state, provider store, or runtime execution.

## 6. NSPanel Architecture

Recommended shape:

- `FloatingChatPanelController` creates and holds one `NSPanel`.
- The panel content is an `NSHostingView` or `NSHostingController` hosting
  `FloatingChatWindowView`.
- The panel uses transparent/non-opaque background treatment.
- The panel uses floating level, with collection behavior chosen to match the
  pet's desktop presence where appropriate.
- Do not use a normal `WindowGroup` for the floating desktop chat surface.
- Do not let `FloatingChatWindowView` directly mutate the AppKit panel.

AppKit boundary:
SwiftUI owns value state and rendering. AppKit owns only the window behavior
that SwiftUI cannot express cleanly:

- transparent floating panel
- capsule/expanded frame changes
- mouse-event pass-through in faded states
- key-window behavior only in expanded mode
- cross-Space/fullscreen auxiliary behavior where appropriate

Suggested panel behavior by state:

- capsule/faded: transparent, non-opaque, low opacity, does not become key,
  may ignore mouse events
- capsule active: accepts mouse click, still avoids keyboard focus
- expanded: key-capable, accepts keyboard input, restores mouse events
- task HUD: visible and readable, default non-key unless clicked

Placement:
P1 can place near the pet or a safe screen edge. Use visible screen frames and
avoid assuming one display size. If the pet position is used, pass only a point
or rect into the floating controller; do not pass overlay ownership.

## 7. Chat Runtime Integration

Required message path:

```text
FloatingChatWindowView
  -> shared chat view model or ChatModel adapter
  -> ChatModel.send(...)
  -> PetAgentRuntimeCoordinator
  -> ModelRouter
  -> CapabilityPermissionGate
  -> ToolRegistry
```

P1 behavior:

- normal text chat only
- show model/provider badge from existing readiness
- show busy/stop state from `ChatModel`
- use existing retry/regenerate where feasible
- do not bypass `ChatModel`
- do not call provider clients from UI
- do not call tools from UI

Agent timeline:
P1 can use a placeholder task/timeline projection if necessary. The real
runtime emits `PetAgentRuntimeOutput`, and future timeline work should project
that output into a UI model rather than letting the panel execute work itself.

Approval card:
P1 can reserve space or a placeholder. P2 should connect it to runtime approval
events and the existing permission gate. The card must not perform side effects
without the runtime/gate path.

## 8. Provider Routing Architecture

The requested routing mode does not exist yet. Future work should add it to the
existing provider/router architecture rather than placing routing logic in the
floating UI.

Proposed future enum:

```swift
enum ModelRoutingMode {
    case cheap
    case balanced
    case strongest
    case localFirst
    case manual
}
```

Expected behavior:

Cheap:

- simple chat: DeepSeek or local model
- intent classification: local model
- reasoning: DeepSeek reasoner when configured
- OpenAI disabled unless manually selected

Balanced:

- simple chat: DeepSeek or local model
- agent planning: MiniMax M3
- code/project analysis: MiniMax M3 or GLM / BigModel
- OpenAI only as fallback or explicit retry with confirmation

Strongest:

- hard reasoning: OpenAI or strongest configured provider
- agent planning: MiniMax M3 or OpenAI
- expensive usage requires budget confirmation
- long-context usage requires confirmation

LocalFirst:

- simple chat and classification: local Ollama
- cloud model only when confidence is low or the user explicitly requests it
- private chat should remain local unless user overrides explicitly

Manual:

- user explicitly chooses provider/model
- app still applies safety and budget checks
- manual selection should not bypass permissions or cost confirmation

Provider notes:

- OpenAI should not be used frequently by default.
- MiniMax M3 is a good default candidate for agent planning when configured.
- DeepSeek is a good low-cost chat/reasoning candidate when configured.
- GLM / BigModel can serve as a backup provider.
- Users should normally select a mode, not a specific model every time.
- The floating chat should initially display the selected badge; it should not
  become the provider routing implementation.

## 9. Budget and Usage Guard

P1 may show only a model badge and readiness state. It does not need real cost
blocking. This document defines the future guardrails.

Future concepts:

```swift
struct UsageBudgetPolicy {
    var dailyBudget: Decimal
    var monthlyBudget: Decimal
    var requireConfirmationForOpenAI: Bool
    var requireConfirmationForExpensiveModels: Bool
    var requireConfirmationForLongContext: Bool
}

struct UsageEstimate {
    var providerID: String
    var modelID: String
    var estimatedInputTokens: Int
    var estimatedOutputTokens: Int
    var estimatedCost: Decimal?
    var currency: String?
    var requiresConfirmation: Bool
    var reason: String?
}
```

Required guard types:

- daily budget
- monthly budget
- single-run estimated cost
- expensive model confirmation
- OpenAI confirmation
- long-context confirmation
- usage meter
- cost estimator

Future flow:

```text
User sends message
  -> routing mode proposes provider/model
  -> CostEstimator estimates single-run cost
  -> UsageMeter checks daily/monthly budget
  -> BudgetGuard allows, asks confirmation, or blocks
  -> ChatModel/runtime proceeds only after approval when required
```

OpenAI policy:
OpenAI usage should require explicit confirmation in default modes, even if the
provider is configured. A one-time action such as "use strongest model once" can
be added later, but it should be visible, auditable, and scoped to one run.

## 10. Permission and Safety Model

Safety chain:

```text
LLM proposes.
Runtime validates.
PermissionGate approves or blocks.
Tools execute.
AgentRunStore records.
UI shows progress.
```

Current repository mapping:

- LLM/structured model proposal: `StructuredDecisionProviding`
- validation/policy: `DecisionEngine`, `StructuredDecisionValidation`, and
  `AgentPlanner`
- permission: `CapabilityPermissionGate`
- execution: `ToolRegistry` and injected tool executors
- durable record: current `AgentTaskLedgerPersisting`; future UI may call this
  `AgentRunStore` or wrap it
- progress display: floating task HUD / timeline projection

Explicitly forbidden:

- automatic shell execution
- automatic file deletion
- automatic source-code modification
- automatic email sending
- automatic secret reads
- automatic credentials/session/token access
- subagents bypassing `CapabilityPermissionGate`
- UI direct tool calls
- prompt text changing permission policy

P1 should not add any new high-risk tool surface. It should only make existing
chat visible and prepare future approval presentation.

## 11. Subagent Future Design

Future structure:

```text
CompanionDirectorAgent
  ├── ResearchAgent
  ├── ProjectCodeAgent
  ├── CalendarAgent
  ├── AssetReviewAgent
  └── SystemAgent
```

Rules:

- the user talks only to `CompanionDirectorAgent`
- subagents return structured results, not user-facing final text
- the director composes the final reply
- each subagent has an explicit tool allowlist
- every tool call still goes through `CapabilityPermissionGate`
- subagents cannot create new permission gates
- subagents cannot widen their parent's capability set
- subagents cannot run unbounded recursive delegation
- user-visible progress is shown through the main floating task timeline

Suggested limits:

```swift
let maxAgentDepth = 2
let maxParallelSubagents = 3
let maxStepsPerRun = 20
let maxToolCallsPerAgent = 8
```

P1 does not implement this loop. P1 should only avoid architecture choices that
would prevent it later.

## 12. Implementation Phases

### P1: Floating Chat Skeleton

- create `NSPanel`
- add state store
- add capsule view
- add expanded chat view
- support hotkey toggle through existing `HotKeys` mechanism
- send text through `ChatModel.send(...)`
- display model badge/readiness
- no deep agent/runtime changes
- no direct provider or tool calls

### P2: Task Timeline + Approval Card

- project runtime task status into a visible timeline
- show approval-card placeholder or real approval request surface
- display permission decision state
- keep execution authority in `PermissionGate`

### P3: Provider Routing UI

- add routing mode selector
- show model badge and selected mode
- define OpenAI confirmation policy
- show budget hints before expensive runs
- avoid asking the user to select a raw model for every message

### P4: Agent Loop Upgrade

- introduce or wrap `AgentRunStore`
- refine `AgentPlanner`
- connect task timeline to runtime outputs
- surface `ToolRegistry` integration through progress, not direct UI calls
- preserve fail-closed approval behavior

### P5: Limited Subagents

- add `ResearchAgent`
- add `ProjectCodeAgent`
- add `CalendarAgent`
- keep explicit allowlists
- keep bounded depth and tool-call limits
- no unrestricted recursion

## 13. P1 Acceptance Criteria

P1 passes when:

- app builds
- floating chat appears as a capsule
- clicking capsule expands it
- chat hotkey expands/toggles it through the existing shortcut mechanism
- Esc collapses it
- inactivity collapses it
- faded capsule does not block normal desktop clicks
- expanded chat can become key and accept keyboard input
- expanded chat sends a text message through the existing `ChatModel` path
- no duplicate runtime is created
- no provider router is duplicated
- no permission gate is duplicated
- no permission bypass exists
- no OpenAI automatic usage is added
- no automatic file write/delete/shell/email behavior is added
- no SwiftUI view directly calls provider clients
- no SwiftUI view directly invokes tools
- tests are added where feasible
- `git diff --check` is clean
