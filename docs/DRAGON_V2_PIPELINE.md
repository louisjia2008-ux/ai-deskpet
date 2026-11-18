# DragonV2 Visual Pipeline

DragonV2 replaces the rejected DragonV1 visual direction. It must advance
through explicit human gates and must not be integrated into runtime until the
final animation package is accepted.

## Stage 1: Static Design Only

Create static concept art, wing anatomy, scale comparisons, and habitat mocks.
Human must accept the static design before animation or layer work begins.

## Stage 2: Layer Split

Separate body, left wing, right wing, tail, and optional shadow into stable
layers. Human must accept the layer structure before animation.

## Stage 3: Wing Rig

Animate only the wing layers around fixed shoulder/back hinges. The body should
remain identity-locked except for approved whole-body transforms such as subtle
hover bob.

## Stage 4: Animation Clips

Only after wing rig acceptance, create:

- idle_hover
- fly_right_loop
- fly_left_loop
- takeoff
- land

Each clip needs visual QA, contact sheets, loop stress previews where
applicable, and human visual acceptance.

## Stage 5: Approval And Runtime Integration

Only after animation visual acceptance, promote assets to `approved/` and add
minimal gated runtime integration. Runtime must remain disabled by default until
explicitly accepted.

## Explicit Ban

Full-frame AI regeneration for every animation frame is banned for DragonV2
unless manually approved, because it caused identity drift and broken wing
geometry in DragonV1.
