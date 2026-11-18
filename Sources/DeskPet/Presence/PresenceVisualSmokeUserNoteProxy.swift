import Foundation
import PetAgentRuntime

/// R1-3 — DEBUG-only proxy used by the presence visual smoke harness to invoke the REAL
/// `noteUserInteraction()` seam on the coordinator (no hand-applied `.wake` event). The
/// proxy keeps the seam callable from a synchronous test step body without exposing the
/// coordinator's reference. Production wiring in `AppDelegate` already calls this seam
/// from `registerUserResponse()` / `overlayMouseDown()` — the proxy simply routes a fire
/// to the same coordinator path so the smoke exercises the wake derivation.
@MainActor
final class PresenceVisualSmokeUserNoteProxy {
    private let coordinator: CharacterPresenceCoordinator
    init(coordinator: CharacterPresenceCoordinator) {
        self.coordinator = coordinator
    }
    func fire() {
        coordinator.noteUserInteraction()
    }
}
