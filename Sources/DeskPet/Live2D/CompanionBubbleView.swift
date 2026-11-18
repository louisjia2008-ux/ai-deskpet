import AppKit

/// Native, content-sized speech card. Text stays point-sized as the model scales.
@MainActor
final class CompanionBubbleView: NSView {
    private let material = NSVisualEffectView()
    private let labels = (0..<4).map { _ in NSTextField(labelWithString: "") }
    private let closeButton = NSButton()
    var onDismiss: (() -> Void)?
    var arrowAtBottom = true { didSet { needsLayout = true; needsDisplay = true } }
    var anchorX: CGFloat = 0 { didSet { needsDisplay = true } }
    private var lastText = ""
    private var lastWidth: CGFloat = 0
    private var measuredSize = CGSize.zero
    private let font = NSFont.systemFont(ofSize: 14)

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.shadowColor = NSColor.black.cgColor
        layer?.shadowOpacity = 0.14
        layer?.shadowRadius = 10
        layer?.shadowOffset = CGSize(width: 0, height: -3)
        material.material = .popover
        material.blendingMode = .behindWindow
        material.state = .active
        material.wantsLayer = true
        material.layer?.cornerRadius = 16
        material.layer?.masksToBounds = true
        addSubview(material)
        for label in labels {
            label.font = font
            label.textColor = .labelColor
            label.maximumNumberOfLines = 1
            label.lineBreakMode = .byClipping
            label.cell?.wraps = false
            addSubview(label)
        }
        closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "关闭气泡")
        closeButton.imageScaling = .scaleProportionallyDown
        closeButton.isBordered = false
        closeButton.contentTintColor = .secondaryLabelColor
        closeButton.target = self
        closeButton.action = #selector(dismiss)
        closeButton.setAccessibilityLabel("关闭气泡")
        addSubview(closeButton)
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { nil }
    override var isOpaque: Bool { false }

    @discardableResult
    func configure(text: String, availableWidth: CGFloat) -> CGSize {
        let cap = max(80, min(308, availableWidth))
        if text == lastText, cap == lastWidth { return measuredSize }
        lastText = text; lastWidth = cap
        let naturalWidth = (text.replacingOccurrences(of: "\n", with: " ") as NSString)
            .size(withAttributes: [.font: font]).width
        let width = min(cap, max(132, ceil(naturalWidth) + 54))
        let lines = SpeechBubbleLayout.lines(for: text, maxWidth: max(1, width - 58), maxLines: 4, fontSize: 14)
        for (index, label) in labels.enumerated() {
            label.stringValue = index < lines.lines.count ? lines.lines[index] : ""
            label.isHidden = index >= lines.lines.count
        }
        toolTip = lines.truncated ? text : nil
        measuredSize = CGSize(width: width, height: CGFloat(max(1, lines.lines.count)) * 20 + 36)
        needsLayout = true
        return measuredSize
    }
    override func layout() {
        super.layout()
        let card = CGRect(x: 0, y: arrowAtBottom ? 8 : 0, width: bounds.width, height: max(0, bounds.height - 8))
        material.frame = card
        for (index, label) in labels.enumerated() {
            label.frame = CGRect(x: 16, y: card.maxY - 14 - CGFloat(index + 1) * 20,
                                 width: max(1, card.width - 54), height: 20)
        }
        closeButton.frame = CGRect(x: card.maxX - 30, y: card.maxY - 30, width: 18, height: 18)
    }
    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let x = min(max(20, anchorX), max(20, bounds.width - 20))
        let edge = arrowAtBottom ? CGFloat(8) : bounds.height - 8
        let tip = arrowAtBottom ? CGFloat(0) : bounds.height
        let path = NSBezierPath()
        path.move(to: CGPoint(x: x - 8, y: edge))
        path.line(to: CGPoint(x: x, y: tip))
        path.line(to: CGPoint(x: x + 8, y: edge))
        path.close()
        NSColor.windowBackgroundColor.withAlphaComponent(0.94).setFill()
        path.fill()
    }
    @objc private func dismiss() { onDismiss?() }
}

/// All coordinates are local AppKit points; fit inside the actual overlay.
enum CompanionBubblePlacement {
    static func frame(size: CGSize, character: CGRect, within bounds: CGRect) -> (frame: CGRect, above: Bool) {
        let safe = bounds.insetBy(dx: 12, dy: 12)
        let width = min(size.width, max(1, safe.width))
        let height = min(size.height, max(1, safe.height))
        let above = character.maxY + 8 + height <= safe.maxY
        let desiredY = above ? character.maxY + 8 : character.minY - 8 - height
        let x = min(max(character.midX - width / 2, safe.minX), safe.maxX - width)
        let y = min(max(desiredY, safe.minY), safe.maxY - height)
        return (CGRect(x: x, y: y, width: width, height: height), above)
    }
}
