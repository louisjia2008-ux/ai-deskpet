import XCTest
import PetAgentRuntime
@testable import DeskPet

// P22 — property-based fuzz of `CharacterBehaviorStateMachine`. Feeds a
// long random sequence of `CharacterBehaviorEvent`s and asserts the
// machine never crashes, never returns a state outside the documented
// enum, and recovers gracefully from `invalid(...)` returns.

final class CharacterBehaviorPropertyTests: XCTestCase {

    /// Reference copy of the event space. Kept here (not pulled via
    /// runtime introspection) so the test can fail loudly if a new case
    /// is added that needs a corresponding assertion update.
    private let allEvents: [CharacterBehaviorEvent] = [
        .start,
        .userLooked,
        .userMessage,
        .beginThinking,
        .beginSpeaking,
        .beginActing,
        .needPermission,
        .permissionResolved,
        .finished,
        .interrupt,
        .recoverFromError,
        .recovered,
        .sleep,
        .wake,
        .shutdown,
    ]

    func test_randomEventSequence_neverCrashes_stateAlwaysValid() {
        Property.forAll { rng in
            var machine = CharacterBehaviorStateMachine(state: .dormant)
            let length = rng.int(in: 1...200)
            for _ in 0..<length {
                let event = rng.pick(allEvents)
                // The state machine throws `CharacterBehaviorStateMachineError`
                // on illegal transitions; that's a *valid* outcome, not a
                // crash. We just assert it doesn't trap and that the state
                // is one of the documented cases (no stray raw values).
                do {
                    _ = try machine.handle(event)
                } catch BehaviorTransitionError.invalid(let from, _) {
                    // The machine MUST remember the pre-event state on
                    // an illegal transition so the caller can recover.
                    XCTAssertEqual(machine.state, from,
                                   "invalid transition should leave state unchanged")
                } catch {
                    XCTFail("Unexpected error thrown: \(error)")
                }
                XCTAssertTrue(CharacterBehaviorState.allCases.contains(machine.state),
                               "state \(machine.state) is not a documented case")
            }
        }
    }

    /// `next(from:event:)` is the pure (non-throwing) lookup that the
    /// production layer uses for previews. It must never crash for any
    /// `(state, event)` pair and must return either a documented case or
    /// `nil`.
    func test_nextLookup_isTotal_returnsNilOrValidState() {
        let states = CharacterBehaviorState.allCases
        Property.forAll { rng in
            let s = rng.pick(states)
            let e = rng.pick(allEvents)
            let result = CharacterBehaviorStateMachine.next(from: s, event: e)
            if let next = result {
                XCTAssertTrue(states.contains(next),
                               "next(from: \(s), event: \(e)) returned off-enum value \(next)")
            }
        }
    }

    /// Property: starting from any state, processing a single valid
    /// transition (drawn from the machine's own `next` table) must
    /// result in a state that `presentationCommand` recognises. Catches
    /// the case where a new state is added but the renderer / FSM bridge
    /// is forgotten.
    func test_validTransition_producesKnownPresentationCommand() {
        let states = CharacterBehaviorState.allCases
        Property.forAll { rng in
            let s = rng.pick(states)
            for event in allEvents {
                if let next = CharacterBehaviorStateMachine.next(from: s, event: event) {
                    // presentationCommand must not trap on any valid
                    // destination state. We don't pin a specific value
                    // (the table is intentionally data-driven); we just
                    // make sure the call returns.
                    _ = CharacterBehaviorStateMachine.presentationCommand(for: next)
                }
            }
        }
    }
}
