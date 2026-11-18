# Agent Animation Event Mapping

## Mapping

| Runtime / UI fact | Renderer event | Animation state | Emotion | Priority |
| --- | --- | --- | --- | --- |
| User sends message | `userMessageReceived` | `listening` | `curious` | 45 |
| Generation task starts | `thinkingStarted` | `thinking` | `curious` | 50 |
| Assistant message begins | `responseStarted` | `speaking` | unchanged | 60 |
| Assistant delta arrives | `responseDelta` | `speaking` | unchanged | 60 |
| Assistant completes | `responseFinished(emotion)` | `reacting` | whitelisted mapped emotion | 40 |
| Generation fails | `responseFailed` | `reacting` | `sad` | 65 |
| Generation cancels | `responseCancelled` | `idle` | `neutral` | 50 |
| Presentation arrives | `emotionChanged` | `reacting` | whitelisted mapped emotion | 40 |
| Pet click | direct user interaction | `reacting` | `neutral` | 70 |
| Drag start | desktop interaction | `dragged` | unchanged | 90 |
| Drag end | desktop interaction | `landing` | unchanged | 80 |

## Whitelist

`PetEmotion` is mapped to renderer emotion through `CharacterAnimationEmotion.init(petEmotion:)`.

- `neutral -> neutral`
- `happy, excited -> happy`
- `shy, thinking -> curious`
- `sad -> sad`
- `sleepy -> sleepy`

Unknown enum values cannot pass because `PetEmotion` is a closed enum in `AICore`.

## Restrictions

- No runtime event maps to a concrete motion filename.
- Speaking is driven by response lifecycle and text delta fallback, not by fake audio lip-sync.
- Dragged state has priority 90 and blocks lower-priority speaking/reaction movement.
- Failed/cancelled paths reset speaking level to zero.
