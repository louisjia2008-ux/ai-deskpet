# Live2D Runtime Integration

## Current Status

Status: BLOCKED_BY_SDK

No formal exported model was found in the read-only external Live2D project audit:

- no `.model3.json`
- no `.moc3`
- no `.motion3.json`
- no `.exp3.json`
- no `physics3.json`

## Runtime Plan

When formal assets and SDK are available, add `Live2DCharacterRenderer` behind the same renderer contract used by `StaticPNGCharacterRenderer`.

Required responsibilities:

- load `.model3.json`
- load textures
- load physics and pose when present
- load expressions and motions
- update Cubism model each frame
- render transparent premultiplied alpha correctly
- handle Retina backing scale
- set state/emotion/speaking level/look target
- perform drawable/art mesh hit testing
- clean resources on shutdown
- log exact fallback reason and fall back to `StaticPNGCharacterRenderer`

## Bridge Rules

If Cubism requires C++:

- use ObjC++ bridge
- keep C++ types out of Swift API
- use RAII on C++ side
- do not expose raw pointers to Swift
- document thread boundaries
- provide bridge-specific error type

## Do Not Claim READY Until

- formal `.model3.json` exists
- textures exist and load
- motions exist and load
- expressions exist and load
- physics exists and loads
- runtime renderer displays the model in the real desktop overlay
