# DeskPet snow-blue production design QA

Source visual truth: `test-results/ui-redesign-20261021/snow-blue-prototype/evidence/12-final-client-1180x749.jpg`.

Implementation: `test-results/ui-production-20261021/final-deskpet-qa.jpg`, captured from the normal Electron runtime with the original encrypted profile, real local Qwen and real Kitty. The source and implementation are both light-theme, populated Chinese chat at 1180 × 749 CSS px, with an unfocused, empty composer. Native window capture is 1180 × 780 px at 1×; its 31 px system titlebar is cropped for the comparison. The source image is 1180 × 749 px at 1×. Actual provider replies and the live pose differ from the seeded prototype by design. The focused handoff view is separately saved as `final-deskpet-native.jpg`.

## Iteration 1

Initial full-view comparison: `test-results/ui-production-20261021/comparison-before-layout.png`.

Focused comparisons: `comparison-composer.png`, `comparison-character.png`, `comparison-navigation.png` in the same evidence folder. These compare both artifacts together, rather than separate remembered views.

- [P2] Long session titles produce horizontal overflow in the recent-chat grid. Evidence: the production side of the full-view comparison shows a horizontal scrollbar below the fourth recent chat. Fix: constrain the grid track with `minmax(0, 1fr)`, allow the button to shrink, and keep vertical scrolling independent of horizontal truncation.
- [P3] Four-character utility labels truncate in the compact 164 px sidebar. Full accessible labels and tooltips remain available. This can be refined in a later typography pass.

Required fidelity surfaces reviewed:

- Typography: native Chinese/macOS font stack, 15 px transcript, compact labels and clear heading hierarchy follow the selected design. Real replies wrap over more lines than seeded copy; this is expected content variance.
- Spacing/layout: the sidebar, open transcript, persistent composer and right character panel keep the selected proportions. The recent-chat overflow above remains actionable.
- Colors: snow-blue sidebar, pale blue user bubbles, white main surfaces, muted blue controls and visible focus ring match the selected direction. The disabled send state differs from the prototype because it now reflects a real empty draft.
- Imagery: real managed Kitty model, transparent full-body framing, dynamic gaze and facial expressions. The production console mirrors the existing desktop renderer; it does not use the prototype's static image or create another WebGL model. Live animation and native JPEG capture soften individual pixels relative to the fixed reference; no clipping or missing model parts is visible.
- Copy: prototype/demo labels were replaced with actual provider, model and action labels. Real chat content is not seeded to imitate the reference. No implementation notes or fabricated service status appear in the product.

## Acceptance evidence already observed

106 non-Minecraft unit checks and 7 IPC checks pass. Six end-to-end workflows pass in `e2e-reactions-acceptance.log`; the seventh real-Kitty workflow passes after correcting its fixture UUID in `e2e-kitty-final.log`. Native Qwen streaming, stop, subsequent sends, native gaze left/right, opacity-based click-through, bounded dragging, two identical motions and scale restoration were observed in the original profile. Idle and chat expressions preserve Watermark; combined evidence: `expressions-comparison.png`.

## Iteration 2

Fixed the P2 finding by constraining the recent-chat grid to `minmax(0, 1fr)`, setting its items' minimum width to zero, and separating vertical scroll from horizontal clipping. The full accessible title and tooltip remain available.

Post-fix full-view evidence: `test-results/ui-production-20261021/comparison-final.png`; source and final production content are shown together at 1180 × 749 px. Focused comparisons in the same folder: `comparison-composer.png`, `comparison-character.png`, `comparison-navigation.png`. The composer remains visible, the model is fully framed, and the recent-chat scrollbar has disappeared with the same long real conversation titles present. The five required surfaces were rechecked; no actionable P0/P1/P2 differences remain.

The rendered regression also creates a long title and checks the sidebar's actual `scrollWidth === clientWidth` at 1180 × 749, 1440 × 1024, 900 × 720 and 820 × 620. All four sizes passed with the composer inside the viewport. Evidence: `test-results/ui-production-20261021/e2e-layout-verified.log` and the associated `viewports.json` under the test output recorded there. The compact layouts' native companion dialog, keyboard focus wrap and Escape focus restoration passed.

Intentional production changes from the prototype: live model instead of a fixed picture; real provider and replies instead of demo text; recent conversations instead of a prototype comparison button; existing feature entry points remain reachable. These implement the user's explicit production-integration request.

## Implementation checklist

1. Recent-chat overflow fixed, rebuilt and visually verified.
2. Chat and real-Kitty workflows rechecked after the layout change.
3. Final normal startup restored the original encrypted profile, 100% scale, Watermark selection and chat history. The main chat window is open for the user; test fixture windows are closed.

## Follow-up polish

The compact utility-label truncation noted above is P3. Tooltips and accessible names provide the complete labels. It does not block chat or navigation.

final result: passed
