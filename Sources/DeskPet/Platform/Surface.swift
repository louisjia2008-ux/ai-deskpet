import CoreGraphics

/// A horizontal line the pet can stand on. Pure value type, no AppKit — unit-testable.
/// Coordinates are global AppKit (bottom-left origin).
public struct Surface: Equatable, Sendable {
    enum Kind: Int, Sendable, Comparable {
        case screenBottom = 0
        case dockTop = 1
        case menuBarBottom = 2
        case windowTop = 3
        static func < (l: Kind, r: Kind) -> Bool { l.rawValue < r.rawValue }
    }

    /// Y of the surface line (where the pet's feet rest).
    var y: CGFloat
    /// Horizontal extent the pet may walk along.
    var xRange: ClosedRange<CGFloat>
    var kind: Kind
    /// Stable identity so we can detect when a surface disappears (e.g. window closed).
    var id: String

    func contains(x: CGFloat) -> Bool { xRange.contains(x) }
    func clamped(x: CGFloat) -> CGFloat { min(max(x, xRange.lowerBound), xRange.upperBound) }
}

/// Pure platform-selection logic. No AppKit; deterministic; tested directly.
enum PerchSolver {

    /// Landing surface when the pet is dropped at `point`: the highest surface that is at or
    /// just below the feet and spans the x. Window tops win ties so the pet perches on windows.
    static func landingSurface(at point: CGPoint,
                               candidates: [Surface],
                               tolerance: CGFloat = 24) -> Surface? {
        let below = candidates.filter { $0.contains(x: point.x) && $0.y <= point.y + tolerance }
        return below.max { a, b in
            if a.y != b.y { return a.y < b.y }      // prefer the highest surface under the feet
            return a.kind < b.kind                   // tie: prefer window top over screen bottom
        }
    }

    /// Always-available fallback (used on safe migration when the current surface vanishes):
    /// the screen-bottom surface whose x-range contains `x`, else the nearest one.
    static func fallbackSurface(near x: CGFloat, candidates: [Surface]) -> Surface? {
        let bottoms = candidates.filter { $0.kind == .screenBottom }
        if let containing = bottoms.first(where: { $0.contains(x: x) }) { return containing }
        return bottoms.min { distance(from: x, to: $0.xRange) < distance(from: x, to: $1.xRange) }
    }

    /// Whether a surface the pet currently stands on still exists in the latest set.
    static func surfaceStillValid(_ surface: Surface, in candidates: [Surface]) -> Bool {
        candidates.contains { $0.id == surface.id }
    }

    private static func distance(from x: CGFloat, to range: ClosedRange<CGFloat>) -> CGFloat {
        if range.contains(x) { return 0 }
        return min(abs(x - range.lowerBound), abs(x - range.upperBound))
    }
}

/// Clamp a point into the union of screen rects so the pet can never be stranded off-screen.
enum ScreenGeometry {
    static let edgePadding: CGFloat = 12
    static let dockPadding: CGFloat = 14
    static let menuBarPadding: CGFloat = 12

    static func clamp(_ point: CGPoint, into screens: [CGRect]) -> CGPoint {
        guard !screens.isEmpty else { return point }
        if screens.contains(where: { $0.contains(point) }) { return point }
        // Snap to the nearest point on the nearest screen rect.
        var best = point
        var bestDist = CGFloat.greatestFiniteMagnitude
        for r in screens {
            let cx = min(max(point.x, r.minX), r.maxX)
            let cy = min(max(point.y, r.minY), r.maxY)
            let d = hypot(point.x - cx, point.y - cy)
            if d < bestDist { bestDist = d; best = CGPoint(x: cx, y: cy) }
        }
        return best
    }

    static func screen(containing point: CGPoint, in screens: [CGRect]) -> CGRect? {
        if let containing = screens.first(where: { $0.contains(point) }) { return containing }
        return nearestScreen(to: point, in: screens)
    }

    static func nearestScreen(to point: CGPoint, in screens: [CGRect]) -> CGRect? {
        screens.min { lhs, rhs in
            distance(from: point, to: lhs) < distance(from: point, to: rhs)
        }
    }

    /// Clamp the pet's feet so the scaled character visual stays inside NSScreen.visibleFrame with
    /// Dock/menu bar padding. This operates in AppKit point coordinates, not source pixels.
    static func clampFeet(_ point: CGPoint, visualSize: CGSize, into visibleFrames: [CGRect]) -> CGPoint {
        guard let screen = screen(containing: point, in: visibleFrames) else { return point }
        let halfWidth = max(visualSize.width / 2, 1)
        let minX = screen.minX + edgePadding + halfWidth
        let maxX = screen.maxX - edgePadding - halfWidth
        let minY = screen.minY + dockPadding
        let maxY = screen.maxY - menuBarPadding - max(visualSize.height, 1)
        return CGPoint(x: clamp(point.x, min: minX, max: maxX),
                       y: clamp(point.y, min: minY, max: maxY))
    }

    static func overlayFrame(forFeet feet: CGPoint,
                             visualSize: CGSize,
                             contentSize: CGSize,
                             feetInset: CGPoint,
                             visibleFrames: [CGRect]) -> CGRect {
        guard let screen = screen(containing: feet, in: visibleFrames) else {
            return CGRect(origin: CGPoint(x: feet.x - feetInset.x, y: feet.y - feetInset.y),
                          size: contentSize)
        }
        let rawOrigin = CGPoint(x: feet.x - feetInset.x, y: feet.y - feetInset.y)
        let minX = screen.minX + edgePadding
        let maxX = screen.maxX - edgePadding - contentSize.width
        let minY = screen.minY + dockPadding
        let maxY = screen.maxY - menuBarPadding - contentSize.height
        let origin = CGPoint(x: clamp(rawOrigin.x, min: minX, max: maxX),
                             y: clamp(rawOrigin.y, min: minY, max: maxY))
        return CGRect(origin: origin, size: contentSize)
    }

    static func visualBounds(forFeet feet: CGPoint, visualSize: CGSize) -> CGRect {
        CGRect(x: feet.x - visualSize.width / 2,
               y: feet.y,
               width: visualSize.width,
               height: visualSize.height)
    }

    static func union(_ rects: [CGRect]) -> CGRect {
        guard var u = rects.first else { return .zero }
        for r in rects.dropFirst() { u = u.union(r) }
        return u
    }

    private static func clamp(_ value: CGFloat, min minValue: CGFloat, max maxValue: CGFloat) -> CGFloat {
        guard minValue <= maxValue else { return (minValue + maxValue) / 2 }
        return Swift.min(Swift.max(value, minValue), maxValue)
    }

    private static func distance(from point: CGPoint, to rect: CGRect) -> CGFloat {
        let cx = Swift.min(Swift.max(point.x, rect.minX), rect.maxX)
        let cy = Swift.min(Swift.max(point.y, rect.minY), rect.maxY)
        return hypot(point.x - cx, point.y - cy)
    }
}
