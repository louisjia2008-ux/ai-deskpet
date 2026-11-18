import Foundation
import PetAgentRuntime

/// DEBUG-only stub advancer for the presence visual smoke harness. Allows the harness to drive
/// any machine state directly so each smoke step captures an unambiguous semantic state.
@MainActor
final class PresenceSmokeStubAdvancer: CharacterBehaviorAdvancing {
    private(set) var state: CharacterBehaviorState
    init(initial: CharacterBehaviorState) { self.state = initial }
    func setState(_ newState: CharacterBehaviorState) async { state = newState }
    var currentState: CharacterBehaviorState { state }
    func advance(_ event: CharacterBehaviorEvent) async -> CharacterBehaviorState? {
        if let next = CharacterBehaviorStateMachine.next(from: state, event: event) {
            state = next
            return next
        }
        return state
    }
}
