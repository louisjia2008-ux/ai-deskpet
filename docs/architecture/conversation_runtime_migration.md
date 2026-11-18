# Conversation Runtime Migration

P4.3 migrates main conversation from the previous PetBrain runtime entry to the native agent
coordinator.

## Previous Call Chain

```text
ChatView
 -> ChatModel.send
 -> append user message
 -> InputEvent.userMessage
 -> InProcessPetBrainRuntime.handle
 -> DialoguePlanner
 -> ModelAdapter
 -> AIServices.generate
 -> LLMService or CloudProvider
 -> CharacterRenderer
 -> ChatModel append pet message
 -> ChatStore
```

The split was that native agent self-tests already used `PetAgentRuntimeCoordinator`, while main chat
used `InProcessPetBrainRuntime`. That allowed conversation state, task state, cancellation, and
capability gating to diverge.

## New Call Chain

```text
ChatView
 -> ChatModel.send
 -> UserMessageEvent
 -> PetAgentRuntimeCoordinator.handle
 -> AppAgentContextBuilder
 -> DecisionEngine
 -> LegacyConversationProvider
 -> AIServices.generate
 -> LLMService or CloudProvider
 -> responseStarted / responseDelta / responseCompleted / presentation
 -> ChatModel updates pending assistant message
 -> ChatStore
```

`InProcessPetBrainRuntime` remains in `PetBrainCore` for legacy tests and reference behavior, but the
formal app chat path no longer instantiates or calls it.

## Persistence Semantics

`ChatModel` persists the accepted user message once, then creates a pending assistant message on
`responseStarted`. Deltas update that pending message. `responseCompleted` marks it completed with
emotion and model route. `cancelled` marks the pending assistant cancelled. `failed` marks it failed
or appends a failed assistant message if no pending message exists.

Temporary and private conversations still do not write through `ChatStore`.
