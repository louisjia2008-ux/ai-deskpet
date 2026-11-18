import CoreGraphics

/// Point-based runtime sizing for the desktop pet. Source PNG pixels and Retina backing scale never
/// decide the visual size directly; every clip is normalized through the same canonical height.
struct PetScaleController: Sendable {
    enum Mode: Sendable {
        case idle
        case interaction
    }

    static let minIdleHeightPt: CGFloat = 96
    static let defaultIdleHeightPt: CGFloat = 132
    static let maxIdleHeightPt: CGFloat = 160
    static let maxInteractionHeightPt: CGFloat = 220

    var preferredIdleHeightPt: CGFloat = Self.defaultIdleHeightPt

    func canonicalHeight(mode: Mode = .idle) -> CGFloat {
        let upperBound = mode == .idle ? Self.maxIdleHeightPt : Self.maxInteractionHeightPt
        return min(max(preferredIdleHeightPt, Self.minIdleHeightPt), upperBound)
    }

    func visualSize(for assetSize: CGSize, mode: Mode = .idle) -> CGSize {
        guard assetSize.width > 0, assetSize.height > 0 else {
            return CGSize(width: canonicalHeight(mode: mode) * 0.6, height: canonicalHeight(mode: mode))
        }
        let height = canonicalHeight(mode: mode)
        let width = assetSize.width / assetSize.height * height
        return CGSize(width: width, height: height)
    }

    func visualSize(forCharacterFootprint footprint: CGSize,
                    ignoringDecorativeBounds decorativeBounds: [CGSize],
                    mode: Mode = .idle) -> CGSize {
        visualSize(for: footprint, mode: mode)
    }

    func scaleFactor(for assetSize: CGSize, mode: Mode = .idle) -> CGFloat {
        guard assetSize.height > 0 else { return 1 }
        return visualSize(for: assetSize, mode: mode).height / assetSize.height
    }
}

enum PetOverlayWindowMetrics {
    static let minimumContentSize = CGSize(width: 148, height: 156)
    static let maximumContentSize = CGSize(width: 280, height: 260)
    static let horizontalCompanionAllowance: CGFloat = 96
    static let topPadding: CGFloat = 36
    static let bottomPadding: CGFloat = 16

    static func contentSize(for visualSize: CGSize) -> CGSize {
        CGSize(width: min(max(visualSize.width + horizontalCompanionAllowance, minimumContentSize.width),
                          maximumContentSize.width),
               height: min(max(visualSize.height + topPadding + bottomPadding, minimumContentSize.height),
                           maximumContentSize.height))
    }

    static func feetInset(for contentSize: CGSize) -> CGPoint {
        CGPoint(x: contentSize.width / 2, y: bottomPadding)
    }
}
