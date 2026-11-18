import CoreGraphics

struct DesktopEntityLayoutState: Equatable {
    var petFeet: CGPoint
    var nestAnchor: CGPoint
    var homeTarget: CGPoint
}

/// Pure layout owner for independent desktop entities. Coordinates are global AppKit points.
struct DesktopEntityLayoutController: Sendable {
    var petVisualSize: CGSize
    var nestSize: CGSize

    init(petVisualSize: CGSize = PetScaleController().visualSize(for: CharacterAnimationConfig.default.footprint),
         nestSize: CGSize = CGSize(width: 132, height: 76)) {
        self.petVisualSize = petVisualSize
        self.nestSize = nestSize
    }

    func defaultState(visibleFrames: [CGRect]) -> DesktopEntityLayoutState {
        let frame = primaryFrame(from: visibleFrames)
        let nest = clampNestAnchor(
            CGPoint(x: frame.minX + 96, y: frame.minY + 38),
            visibleFrames: visibleFrames)
        let pet = ScreenGeometry.clampFeet(
            CGPoint(x: frame.minX + 80, y: frame.minY + ScreenGeometry.dockPadding),
            visualSize: petVisualSize,
            into: visibleFrames)
        return DesktopEntityLayoutState(petFeet: pet,
                                        nestAnchor: nest,
                                        homeTarget: homeTarget(forNestAnchor: nest,
                                                               visibleFrames: visibleFrames))
    }

    func draggingPet(to petFeet: CGPoint,
                     current: DesktopEntityLayoutState,
                     visibleFrames: [CGRect]) -> DesktopEntityLayoutState {
        let pet = ScreenGeometry.clampFeet(petFeet,
                                           visualSize: petVisualSize,
                                           into: visibleFrames)
        return DesktopEntityLayoutState(petFeet: pet,
                                        nestAnchor: current.nestAnchor,
                                        homeTarget: homeTarget(forNestAnchor: current.nestAnchor,
                                                               visibleFrames: visibleFrames))
    }

    func screenChanged(current: DesktopEntityLayoutState,
                       visibleFrames: [CGRect]) -> DesktopEntityLayoutState {
        let pet = ScreenGeometry.clampFeet(current.petFeet,
                                           visualSize: petVisualSize,
                                           into: visibleFrames)
        let nest = clampNestAnchor(current.nestAnchor, visibleFrames: visibleFrames)
        return DesktopEntityLayoutState(petFeet: pet,
                                        nestAnchor: nest,
                                        homeTarget: homeTarget(forNestAnchor: nest,
                                                               visibleFrames: visibleFrames))
    }

    func clampNestAnchor(_ anchor: CGPoint, visibleFrames: [CGRect]) -> CGPoint {
        guard !visibleFrames.isEmpty else { return anchor }
        let screen = ScreenGeometry.screen(containing: anchor, in: visibleFrames)
            ?? primaryFrame(from: visibleFrames)
        let halfWidth = nestSize.width / 2
        let minX = screen.minX + ScreenGeometry.edgePadding + halfWidth
        let maxX = screen.maxX - ScreenGeometry.edgePadding - halfWidth
        let minY = screen.minY + 20
        let maxY = screen.maxY - ScreenGeometry.menuBarPadding - nestSize.height
        return CGPoint(x: clamp(anchor.x, min: minX, max: maxX),
                       y: clamp(anchor.y, min: minY, max: maxY))
    }

    func homeTarget(forNestAnchor anchor: CGPoint, visibleFrames: [CGRect]) -> CGPoint {
        let screen = ScreenGeometry.screen(containing: anchor, in: visibleFrames)
            ?? primaryFrame(from: visibleFrames)
        let raw = CGPoint(x: anchor.x + 22,
                          y: screen.minY + ScreenGeometry.dockPadding)
        return ScreenGeometry.clampFeet(raw, visualSize: petVisualSize, into: visibleFrames)
    }

    private func primaryFrame(from frames: [CGRect]) -> CGRect {
        frames.first ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
    }

    private func clamp(_ value: CGFloat, min minValue: CGFloat, max maxValue: CGFloat) -> CGFloat {
        guard minValue <= maxValue else { return (minValue + maxValue) / 2 }
        return Swift.min(Swift.max(value, minValue), maxValue)
    }
}
