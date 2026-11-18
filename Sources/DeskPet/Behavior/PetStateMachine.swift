import Foundation
import CoreGraphics

/// High-level behaviors. Transitions are deliberate (with min dwell) so motion reads as
/// continuous life, not random GIFs (doc §17.1 "生命感").
enum PetActivity: Equatable {
    case idle          // breathing / blinking in place
    case wander        // strolling along the current surface
    case pickedUp      // being dragged — surprised, dangling
    case falling       // released, seeking a landing surface
    case recalling     // travelling home
}

/// Pure-ish decision logic driving activity transitions. Geometry is injected so the core
/// is testable without AppKit. The owner advances `tick` on a low-frequency timer.
@MainActor
final class PetStateMachine {

    private(set) var activity: PetActivity = .idle
    private var dwell: TimeInterval = 0          // time spent in current activity
    private let minDwell: TimeInterval = 1.2
    private var wanderTarget: CGFloat?

    /// P16 — set true while the presence coordinator is in an engaged semantic state
    /// (thinking/working/waiting/speaking/sleeping). Blocks the idle→wander gate so the
    /// character physically holds still while the user is interacting with it. Recall and
    /// drag transitions are unaffected (they transition directly, not via the idle gate).
    var suppressWander: Bool = false

    let state: PetState
    init(state: PetState) { self.state = state }

    // External events -------------------------------------------------------

    func beginDrag() { transition(.pickedUp) }

    func endDrag() { transition(.falling) }

    func recall() {
        state.isHidden = false
        transition(.recalling)
    }

    /// Land on a resolved surface (called after `.falling` finds a platform).
    func land(on surface: Surface) {
        state.currentSurface = surface
        var p = state.position
        p.y = surface.y
        p.x = surface.clamped(x: p.x)
        state.position = p
        transition(.idle)
    }

    /// P16 — presence coordinator engage rising edge. Force the pet into idle so the
    /// coordinated visual (thinking/working/listening/sleeping) is coherent with the
    /// physical motion; also pair with `suppressWander = true` so the wander gate stays closed.
    /// Guarded so recall/drag/falling transitions remain unaffected (they bypass the idle gate).
    func holdStill() {
        guard activity == .wander || activity == .idle else { return }
        activity = .idle
        dwell = 0
    }

    // Per-tick update -------------------------------------------------------

    /// Advance autonomous behavior. Returns the desired feet position for this tick.
    /// `dt` seconds elapsed; `walkSpeed` in points/second.
    func tick(dt: TimeInterval, walkSpeed: CGFloat = 60) -> CGPoint {
        dwell += dt
        let dts = CGFloat(dt)
        switch activity {
        case .idle:
            if !state.pinned, !suppressWander, dwell > 3.5, let s = state.currentSurface, s.xRange.upperBound - s.xRange.lowerBound > 40 {
                wanderTarget = randomTarget(in: s.xRange)
                transition(.wander)
            }
        case .wander:
            if let surface = state.currentSurface, let target = wanderTarget {
                var p = state.position
                let dir: CGFloat = target > p.x ? 1 : -1
                state.facing = dir
                p.x += dir * walkSpeed * dts
                p.x = surface.clamped(x: p.x)
                p.y = surface.y
                state.position = p
                let reachedTarget = abs(p.x - target) < walkSpeed * dts + 1
                let hitEdge = p.x == surface.xRange.lowerBound || p.x == surface.xRange.upperBound
                if reachedTarget || hitEdge {
                    transition(.idle)
                }
            } else {
                transition(.idle)
            }
        case .recalling:
            var p = state.position
            let target = state.home
            let v = CGVector(dx: target.x - p.x, dy: target.y - p.y)
            let dist = hypot(v.dx, v.dy)
            let step = max(walkSpeed * 2.5, 1) * dts
            if dist <= step {
                p = target
                state.position = p
                transition(.idle)
            } else {
                state.facing = v.dx >= 0 ? 1 : -1
                p.x += v.dx / dist * step
                p.y += v.dy / dist * step
                state.position = p
            }
        case .pickedUp, .falling:
            break // position driven by drag / landing resolution
        }
        return state.position
    }

    // Helpers ---------------------------------------------------------------

    private func transition(_ next: PetActivity) {
        guard next != activity else { return }
        if dwell < minDwell, next == .idle { /* allow */ }
        activity = next
        dwell = 0
    }

    private func randomTarget(in range: ClosedRange<CGFloat>) -> CGFloat {
        CGFloat.random(in: range)
    }
}
