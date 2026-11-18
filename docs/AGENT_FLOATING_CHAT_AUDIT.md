# DeskPet Floating Chat Audit

## 1. Current Architecture Inventory

This audit is based on the current SwiftPM macOS app under `Sources/DeskPet`,
`Sources/AICore`, and `Sources/PetAgentRuntime`. The repository already has a
real chat -> runtime -> provider/tool path. The floating chat work should expose
that path on the desktop, not replace it.

### ChatModel

File:
`Sources/DeskPet/AI/ChatModel.swift`

Current responsibility:
`ChatModel` is the UI-facing conversation model. It owns conversation history,
pending assistant message state, retry/regenerate/cancel behavior, and the
bridge from user text into `PetAgentRuntimeCoordinator.handle(...)`.

Reuse for floating chat:
The floating chat should send normal user text through `ChatModel.send(...)`.
It can either reuse `CompanionChatViewModel` or introduce a small adapter around
the same `ChatModel`.

Risk / caveat:
Do not let the floating chat create its own conversation runtime, own its own
message persistence, or call provider clients directly. `ChatModel` already
normalizes message lifecycle and cancellation.

### PetAgentRuntimeCoordinator

File:
`Sources/PetAgentRuntime/PetAgentRuntimeCoordinator.swift`

Current responsibility:
`PetAgentRuntimeCoordinator` is the single top-level runtime for user messages,
agent decisions, tool plan execution, approval waits, cancellation, proactive
runtime decisions, and durable ledger events. It emits `PetAgentRuntimeOutput`
for UI layers to consume.

Reuse for floating chat:
The floating chat must reach the coordinator only through the existing chat
path. This preserves the single runtime boundary:

```text
Floating chat UI -> ChatModel -> PetAgentRuntimeCoordinator
```

Risk / caveat:
Creating a second coordinator for floating chat would split cancellation,
ledger, permission, tool execution, and animation events. That is the main
architecture failure to avoid.

### AgentRuntimeContainer

File:
`Sources/DeskPet/Runtime/AgentRuntimeContainer.swift`

Current responsibility:
`AgentRuntimeContainer` constructs and owns the one app-level
`PetAgentRuntimeCoordinator`, the shared `CapabilityPermissionGate`,
`ToolRegistry`, audit sink, event bus, action dispatcher, lifecycle controller,
and presentation driver.

Reuse for floating chat:
The floating chat should receive already-created dependencies from
`AppDelegate`, especially the shared `ChatModel` and provider/readiness models.
It should not construct `AgentRuntimeContainer`.

Risk / caveat:
No floating chat controller should become a dependency injection container. It
should not register tools, bootstrap runtime lifecycle, or allocate its own gate.

### ProviderStore

File:
`Sources/DeskPet/AI/ProviderStore.swift`

Current responsibility:
`ProviderStore` owns provider configuration, fetched/manual model descriptors,
role defaults, connection status, readiness, and Keychain-backed secret
references. It persists provider metadata, not raw API keys.

Reuse for floating chat:
The floating chat can read `ProviderStore.readiness()` for the model badge and
disable/guide sending when no model is ready. It should use the existing
`ModelReadinessState` labels.

Risk / caveat:
Do not add a second provider list, second selected-model state, or UI-only API
key state. Provider/client execution belongs below `AIServices` and
`ModelRouter`, not in the floating UI.

### ModelRouter

File:
`Sources/AICore/ModelRouter.swift`

Current responsibility:
`ModelRouter` currently has two layers:

- prompt-level local/cloud recommendation for older routing behavior
- role-level provider/model selection through `route(_:providers:defaults:secretStore:)`

Reuse for floating chat:
The floating chat should display the selected role/default model via
`ProviderStore` and should let runtime generation continue using the existing
router path.

Risk / caveat:
The requested `ModelRoutingMode` does not exist yet. Future routing-mode work
should extend the existing router/defaults model rather than adding a parallel
router inside floating chat.

### CapabilityPermissionGate

File:
`Sources/PetAgentRuntime/PermissionModel.swift`

Current responsibility:
`CapabilityPermissionGate` composes app-side `CapabilityGate` decisions with
macOS/system authorization status and resolves whether a capability is actually
executable. It audits granted/denied decisions.

Reuse for floating chat:
Approval cards and task progress in the floating UI should reflect decisions
that come from the runtime/gate path. The UI may present approval requests, but
it must not approve or execute tools itself.

Risk / caveat:
Do not introduce a UI-level permission shortcut such as "floating chat trusted".
All tools, including future subagent tools, must pass through this gate.

### ToolRegistry

File:
`Sources/PetAgentRuntime/ToolRegistry.swift`

Current responsibility:
`ToolRegistry` stores registered runtime tools and checks each declared
capability through `PermissionGate` before execution. It handles timeout,
cancellation, audit records, and runtime event bus notifications.

Reuse for floating chat:
The floating chat can show task/tool progress emitted by the runtime. It should
not look up or invoke `ToolRegistry` directly.

Risk / caveat:
A floating UI button that directly calls a runtime tool would bypass the agent
plan lifecycle and could skip user-visible approvals or ledger semantics.

### OverlayWindow

File:
`Sources/DeskPet/Window/OverlayWindow.swift`

Current responsibility:
`OverlayWindow` is a transparent, borderless, always-on-top desktop pet window.
It is click-through by default, joins all Spaces, supports fullscreen auxiliary
behavior, and cannot become key/main.

Reuse for floating chat:
Its window policy is a useful reference for click-through, transparent, and
cross-Space behavior. Some constants or placement ideas can inform the floating
panel.

Risk / caveat:
`OverlayWindow` cannot accept keyboard input because it intentionally cannot
become key/main. The expanded chat needs text input, so it should be a separate
`NSPanel`, not a child of `OverlayWindow`.

### OverlayWindowController

File:
`Sources/DeskPet/Window/OverlayWindowController.swift`

Current responsibility:
`OverlayWindowController` owns pet placement, surface tracking, drag behavior,
screen changes, proactivity ticks, bubble display, animation events, and pet
touch callbacks.

Reuse for floating chat:
It can expose a narrow callback such as "pet clicked" or "pet requested chat".
That callback should notify a floating chat controller owned by `AppDelegate`.

Risk / caveat:
Do not let `OverlayWindowController` own chat state, provider state, AppKit
chat panel lifecycle, or runtime execution. Pet overlay and floating chat should
be peer controllers coordinated above, not mutually owning each other.

### HotKeys

File:
`Sources/DeskPet/Input/HotKeys.swift`

Current responsibility:
`HotKeys` installs local and global `NSEvent` key-down monitors for Command +
Option shortcuts. It exposes callbacks for hide, recall, quick task, and quick
chat.

Reuse for floating chat:
P1 can reuse the existing callback shape by mapping the current quick-chat
shortcut to a floating-chat toggle, or by adding a similarly scoped callback in
a later implementation pass.

Risk / caveat:
This is not a true system-wide registered hotkey implementation. Event monitors
may not fire in all apps, secure input contexts, permission states, or focus
conditions. Do not document it as a guaranteed global hotkey.

### Current Control Panel / Settings UI Entrypoints

Files:

- `Sources/DeskPet/UI/MainWindowController.swift`
- `Sources/DeskPet/UI/AppShellView.swift`
- `Sources/DeskPet/UI/CompanionChatView.swift`
- `Sources/DeskPet/UI/ProviderCenterView.swift`
- `Sources/DeskPet/UI/ModelCenterView.swift`
- `Sources/DeskPet/UI/RuntimeSettingsViews.swift`
- `Sources/DeskPet/UI/SettingsView.swift`
- `Sources/DeskPet/MenuBar/StatusItemController.swift`

Current responsibility:
`MainWindowController` hosts the normal settings/control window. `AppShellView`
is the sidebar/detail shell. `CompanionChatView` is the first-class chat page in
that shell. Provider/model/runtime/settings pages configure the AI and safety
environment. `StatusItemController` exposes menu-bar actions including quick
chat.

Reuse for floating chat:
Reuse view models, readiness labels, design tokens, and send/cancel behavior
where appropriate. The floating chat should feel related to the companion UI
but should not become a miniature control panel.

Risk / caveat:
Copying control-panel pages into the floating panel would make the everyday
desktop chat heavy and hard to maintain. P1 should stay focused on capsule,
expanded chat, model badge, and safe task/approval surface.

### Current Pet Renderer / Animation FSM Entrypoints

Files:

- `Sources/DeskPet/Render/PetScene.swift`
- `Sources/DeskPet/Render/CharacterAnimationTypes.swift`
- `Sources/DeskPet/Render/CharacterAnimationStateMachine.swift`
- `Sources/DeskPet/Render/StaticPNGCharacterRenderer.swift`
- `Sources/DeskPet/Render/StaticSpritePresentationDriver.swift`
- `Sources/DeskPet/Window/OverlayWindowController.swift`

Current responsibility:
`PetScene` hosts the SpriteKit scene. `CharacterAnimationTypes` defines
animation states, intents, and agent animation mapping. The animation state
machine handles transitions and cooldowns. Static renderers draw character
sprites. `StaticSpritePresentationDriver` bridges runtime presentation commands
to the overlay.

Reuse for floating chat:
The floating chat can trigger existing pet animation intent through the current
UI intent/presentation bridge if the user clicks, sends, or receives a reply.
It should not render or mutate pet animation state directly.

Risk / caveat:
Keep chat panel rendering separate from pet rendering. The pet remains the
companion character; the panel is only an interaction surface.

## 2. Reuse Decision

Modules that must be reused:

- `ChatModel`
- `PetAgentRuntimeCoordinator`
- `AgentRuntimeContainer`
- `ProviderStore`
- `ModelRouter`
- `CapabilityPermissionGate`
- `ToolRegistry`
- `ModelReadinessState`
- existing pet animation intent/presentation path

Modules that can be extended:

- `HotKeys`, to route a chat shortcut to floating chat toggle behavior.
- `AppDelegate`, to create and connect the floating chat controller.
- `OverlayWindowController`, only through a narrow callback when pet click/touch
  should request chat expansion.
- `CompanionChatViewModel`, if it can be made reusable without importing
  floating panel lifecycle details.
- Provider routing types, in a later phase, to add `ModelRoutingMode` and budget
  checks to the existing router path.

Modules that must not be copied:

- `ChatModel`
- `PetAgentRuntimeCoordinator`
- `AgentRuntimeContainer`
- `ProviderStore`
- `ModelRouter`
- `CapabilityPermissionGate`
- `ToolRegistry`
- provider client construction and API key handling
- runtime/tool approval logic

Logic that must not live in floating chat UI:

- provider client calls
- API key reads/writes
- tool lookup or invocation
- permission grants
- agent plan validation
- runtime lifecycle bootstrap/shutdown
- ledger writes
- shell/file/email automation
- pet animation FSM mutation beyond a narrow intent callback

Target P1 boundaries:

```text
FloatingChatPanelController only owns NSPanel lifecycle.
FloatingChatStateStore only owns floating chat UI state.
FloatingChatWindowView only renders and collects input.
Message sending still goes through ChatModel.send(...).
Agent execution still goes through PetAgentRuntimeCoordinator.
Tool permission still goes through CapabilityPermissionGate / ToolRegistry.
```

## 3. Duplication Risks

### New Second Chat Runtime

Risk:
A new floating-chat runtime would create inconsistent message lifecycle,
cancel/retry behavior, task IDs, and durable ledger state.

Avoidance:
Floating chat must reuse `ChatModel.send(...)` and observe the same
conversation state.

### New Second Provider Router

Risk:
Floating chat could drift from the model selected in the control panel or use a
provider when readiness says it is disconnected.

Avoidance:
Read readiness and badge text from `ProviderStore`; route execution through the
existing `ModelRouter` path below `AIServices`.

### New Second Permission Gate

Risk:
UI-specific trust flags can bypass the real app/system authorization boundary.

Avoidance:
Approval display can be added in UI, but execution authority remains
`CapabilityPermissionGate` and `ToolRegistry`.

### Floating UI Directly Calls Tools

Risk:
Buttons in the floating panel could execute side effects without plan
validation, broker evaluation, audit events, or ledger updates.

Avoidance:
No direct `ToolRegistry.invoke(...)` from floating UI. Tool actions must come
from validated runtime decisions.

### OverlayWindow and FloatingChatPanel Circular Ownership

Risk:
If overlay owns chat and chat owns overlay, window lifecycle, pet clicks, and
animation events can form retain cycles or order-dependent bugs.

Avoidance:
`AppDelegate` should coordinate peer controllers. Overlay emits a narrow event;
floating chat consumes it.

### Control Panel Logic Copied to Floating Chat

Risk:
The panel becomes a second settings app with duplicated provider, model,
privacy, and runtime pages.

Avoidance:
Floating chat should link or signal "open settings" rather than copying
settings surfaces.

### HotKeys Misrepresented as True Global Hotkeys

Risk:
Users expect guaranteed system-wide behavior, but current implementation uses
event monitors.

Avoidance:
Document it as best-effort P1 behavior and defer true global registration until
the product needs it.

## 4. Existing HotKeys Limitation

Current implementation:
`HotKeys` uses `NSEvent.addGlobalMonitorForEvents(matching: .keyDown, ...)` and
`NSEvent.addLocalMonitorForEvents(matching: .keyDown, ...)`.

Likely effective cases:

- when DeskPet is frontmost, through the local monitor
- when macOS permits the app to observe global key events
- when the active app/context does not suppress the relevant key events
- when the shortcut is not already consumed by the foreground app

Likely ineffective cases:

- secure input fields or password prompts
- apps or system surfaces that prevent global monitor delivery
- missing Input Monitoring/accessibility-style permission conditions
- shortcut conflicts with a foreground app
- cases where the accessory app is not active and global monitor delivery is
  unavailable

Why P1 can reuse it:

- P1 acceptance only needs a lightweight toggle path, not a guaranteed
  system-wide command.
- Menu-bar and pet-click triggers can provide fallback access.
- Reusing the existing mechanism avoids introducing new permission prompts in
  the first implementation.

When to upgrade:

- if the shortcut becomes a primary daily workflow
- if user testing shows frequent failure outside the app
- if fullscreen/Spaces behavior requires more reliable invocation
- if accessibility testing requires predictable keyboard access

Upgrade cautions:

- avoid surprising Input Monitoring or Accessibility permission prompts
- explain the permission only when the user enables the feature
- keep a menu-bar/pet-click fallback
- do not add keyboard monitoring beyond the chosen shortcut
- do not log raw key events

Do not implement true global hotkey registration in this document-only pass.

## 5. Existing OverlayWindow Interaction

`OverlayWindow` is already tuned for the pet:

- transparent and non-opaque
- borderless
- status-bar level
- click-through by default
- joins all Spaces
- supports fullscreen auxiliary behavior
- cannot become key or main

Reusable policy:
The floating chat can reuse the philosophy: weak desktop presence, transparent
background, carefully controlled hit testing, and cross-Space behavior where it
does not disrupt the user's work.

Why floating chat should be an independent `NSPanel`:

- expanded chat needs keyboard focus and text input
- capsule/HUD states need different hit testing than the pet
- panel lifecycle should be independent of pet SpriteKit rendering
- chat placement may follow the pet, screen edge, or persisted user placement
- the pet overlay intentionally cannot become key/main

Pet-click expansion rule:
When the user clicks or interacts with the pet, `OverlayWindowController` should
notify a floating chat controller through a narrow callback. It should not own
chat state, provider readiness, AppKit panel creation, or runtime calls.

Suggested ownership:

```text
AppDelegate
  owns OverlayWindowController
  owns FloatingChatPanelController
  wires overlay.onPetTouched / onChatRequested -> floatingChat.expand()
```

## 6. Worktree Safety Note

This pass is documentation-only.

Allowed file changes:

- `docs/AGENT_FLOATING_CHAT_AUDIT.md`
- `docs/AGENT_FLOATING_CHAT_ARCHITECTURE.md`

Do not:

- modify Swift source
- modify `Package.swift`
- modify Xcode project/workspace files
- add floating chat skeleton code
- modify runtime behavior
- stage changes
- commit changes
- clean the worktree
- run `git reset`
- run `git restore`
- run `git checkout`
- run `git clean`
- read credentials, sessions, tokens, `.env`, assistant config, or external
  OpenClaw/Hermes/Claude/Cursor state

The current repository may already contain unrelated dirty or untracked files.
Those files must be left untouched.
