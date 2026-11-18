import CoreGraphics
import Foundation

struct FloatingChatPanelPlacement {
    var visibleFrame: CGRect
    var screenMargin: CGFloat
    var bottomOffset: CGFloat
    var edgePadding: CGFloat = 8

    func defaultAnchor() -> CGPoint {
        CGPoint(x: visibleFrame.maxX - screenMargin,
                y: visibleFrame.minY + bottomOffset)
    }

    func frame(size: CGSize, anchor: CGPoint?) -> CGRect {
        let resolvedAnchor = anchor ?? defaultAnchor()
        let origin = CGPoint(x: resolvedAnchor.x - size.width,
                             y: resolvedAnchor.y)
        return CGRect(origin: clampedOrigin(origin, size: size), size: size).integral
    }

    func anchor(for frame: CGRect) -> CGPoint {
        CGPoint(x: frame.maxX, y: frame.minY)
    }

    func translatedAnchor(from anchor: CGPoint, translation: CGSize) -> CGPoint {
        CGPoint(x: anchor.x + translation.width,
                y: anchor.y - translation.height)
    }

    private func clampedOrigin(_ origin: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: clamp(origin.x,
                         lower: visibleFrame.minX + edgePadding,
                         upper: visibleFrame.maxX - size.width - edgePadding),
                y: clamp(origin.y,
                         lower: visibleFrame.minY + edgePadding,
                         upper: visibleFrame.maxY - size.height - edgePadding))
    }

    private func clamp(_ value: CGFloat, lower: CGFloat, upper: CGFloat) -> CGFloat {
        guard lower <= upper else {
            return (lower + upper) / 2
        }
        return min(max(value, lower), upper)
    }
}
/// P17 / R2-04 — the floating chat panel's expanded-size memory, extracted out of
/// `FloatingChatPanelController` so the resize-persistence behaviour is the SAME code the
/// controller runs AND is directly testable (the previous test re-implemented the clamp
/// locally, so it could not detect a regression).
///
/// Contract:
/// * `expandedSize` is the size the panel should open at, always clamped to the design spec.
/// * `noteResize(to:state:)` records a user-driven resize, but ONLY while the panel is
///   expanded — a capsule/HUD frame must never overwrite the remembered expanded size.
/// * The remembered size survives collapse→expand (that is the whole point of R1-08/R2-04).
struct FloatingChatExpandedSizeMemory: Equatable {
    private var remembered: CGSize

    init(initial: CGSize = FloatingChatPanelMetrics.expandedIdealSize) {
        self.remembered = Self.clamped(initial)
    }

    /// The size to use for the next `.expanded` presentation.
    var expandedSize: CGSize { Self.clamped(remembered) }

    /// Clamp to the design spec; degenerate sizes fall back to the production ideal size
    /// so the first open matches EVID-06 (420×520).
    static func clamped(_ size: CGSize) -> CGSize {
        let minSize = FloatingChatPanelMetrics.expandedMinSize
        let maxSize = FloatingChatPanelMetrics.expandedMaxSize
        if size.width < 1 || size.height < 1 {
            return FloatingChatPanelMetrics.expandedIdealSize
        }
        return CGSize(width: min(max(size.width, minSize.width), maxSize.width),
                      height: min(max(size.height, minSize.height), maxSize.height))
    }

    /// Record a live/user resize. Returns true when the memory actually changed.
    @discardableResult
    mutating func noteResize(to size: CGSize,
                             state: FloatingChatVisibilityState) -> Bool {
        guard state == .expanded else { return false }
        let clamped = Self.clamped(size)
        guard clamped != remembered else { return false }
        remembered = clamped
        return true
    }
}
