import AppKit

/// Bridges NSScreen into global AppKit-coordinate surfaces and provides the
/// CG(top-left) → AppKit(bottom-left) flip used by window tracking.
@MainActor
public final class ScreenManager {

    /// Height of the primary screen — the reference for flipping CG coordinates.
    var primaryHeight: CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    /// All screen frames in global AppKit coordinates.
    var screenFrames: [CGRect] { NSScreen.screens.map(\.frame) }

    /// All visible screen frames in global AppKit coordinates, excluding Dock and menu bar.
    var visibleScreenFrames: [CGRect] { NSScreen.screens.map(\.visibleFrame) }

    /// The union rect covering every display (overlay window frame).
    var desktopUnion: CGRect { ScreenGeometry.union(screenFrames) }

    /// One screen-bottom surface per display (the always-available default floor),
    /// plus the menu-bar bottom of the primary screen.
    func screenSurfaces() -> [Surface] {
        var out: [Surface] = []
        for (i, screen) in NSScreen.screens.enumerated() {
            let f = screen.visibleFrame   // excludes Dock + menu bar
            out.append(Surface(y: f.minY + ScreenGeometry.dockPadding,
                               xRange: f.minX...f.maxX,
                               kind: .screenBottom,
                               id: "screen-bottom-\(i)"))
        }
        return out
    }

    /// Convert a CGWindowList bounds rect (top-left origin) to a window-top Surface
    /// in global AppKit coordinates.
    func windowTopSurface(cgBounds: CGRect, id: String) -> Surface {
        let topY = primaryHeight - cgBounds.minY     // visual top edge of the window
        return Surface(y: topY,
                       xRange: cgBounds.minX...cgBounds.maxX,
                       kind: .windowTop,
                       id: id)
    }
}
