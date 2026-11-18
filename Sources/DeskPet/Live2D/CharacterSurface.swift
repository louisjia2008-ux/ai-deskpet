import AppKit
import AICore
import UniformTypeIdentifiers

/// Native production character surface. No SpriteKit scene exists in this path.
@MainActor
final class CharacterSurface: NSView {
    static let rendererIdentity = "deskpet.live2d"
    static let unscaledFootprint = CharacterAnimationConfig.default.footprint
    static var footprint: CGSize { PetScaleController().visualSize(for: unscaledFootprint) }
    static func visualSize(height: CGFloat) -> CGSize {
        CGSize(width: unscaledFootprint.width / unscaledFootprint.height * height, height: height)
    }
    var preferredHeight: CGFloat = 240
    let host: Live2DCharacterHost
    private let modelRoot: URL
    private let semanticMachine = CharacterAnimationStateMachine()
    private(set) var characterState = CharacterSurfaceState()
    var currentIntent: CharacterAnimationIntent { characterState.intent }
    private let bubble = CompanionBubbleView(frame: .zero)
    private let status = NSTextField(wrappingLabelWithString: "")
    private let hostPicker = NSButton(title: "选择角色 ZIP", target: nil, action: nil)
    private let retryButton = NSButton(title: "重新载入", target: nil, action: nil)
    private let badge = NSTextField(labelWithString: "")
    private let transientGlyph = NSTextField(labelWithString: "")
    private let studyBook = NSImageView()
    private var glyphStarted: TimeInterval?
    private var glyphDuration: TimeInterval = 0
    private var bubbleText: String?
    private var config = CharacterModelConfiguration()
    private var configurationError: String?
    private var pendingImport: CharacterModelSelection?
    private var elapsed: TimeInterval = 0
    private var lookTarget: CGPoint?
    private var facing: CGFloat = 1
    private var started = false
    private var studyActive = false
    var onGeometryChanged: (() -> Void)?
    var onExpressionsChanged: (([String]) -> Void)?
    private var reactionEndsAt: TimeInterval = 0
    private var expressionPreviewEndsAt: TimeInterval = 0
    var onBubbleDismissed: (() -> Void)?
    var characterFrame: CGRect { host.frame }
    var visualBounds: CGRect { host.visualBounds }
    var bubbleAnchor: CGPoint { CGPoint(x: visualBounds.midX, y: visualBounds.maxY + 8) }
    var dragState: Bool { characterState.dragging }
    var display: NSScreen? { window?.screen }
    var visibility: Bool { characterState.visible }
    var attentionTarget: CGPoint? { characterState.attentionTarget }

    init(frame: NSRect, modelRoot: URL = Live2DLocalResources.managedModelDirectory) {
        self.modelRoot = modelRoot
        host = Live2DCharacterHost(root: modelRoot)
        super.init(frame: frame)
        addSubview(host.bridge.webView)
        for view in [bubble, status, hostPicker, retryButton, badge, transientGlyph, studyBook] { addSubview(view) }
        bubble.onDismiss = { [weak self] in
            self?.hideBubble()
            self?.onBubbleDismissed?()
        }
        bubble.isHidden = true
        transientGlyph.font = .systemFont(ofSize:22); transientGlyph.isHidden = true
        studyBook.image = NSImage(systemSymbolName:"book.fill",accessibilityDescription:"专注阅读")
        studyBook.isHidden = true
        status.drawsBackground = true; status.backgroundColor = .windowBackgroundColor
        status.textColor = .labelColor
        hostPicker.target = self; hostPicker.action = #selector(chooseModel)
        retryButton.target = self; retryButton.action = #selector(reloadModels)
        host.onChange = { [weak self] in self?.modelChanged() }
    }
    required init?(coder: NSCoder) { nil }
    func start() {
        guard !started else { return }; started = true
        readConfiguration()
        assert(subviews.filter { $0 === host.bridge.webView }.count == 1)
        NSLog("Canonical character surface: %@; hosts=1 bridges=1 webViews=1", Self.rendererIdentity)
        host.start(selection: config.character)
        refreshUI()
    }
    private func readConfiguration() {
        do { config = try CharacterModelConfiguration.load(root: modelRoot); configurationError = nil }
        catch { config = CharacterModelConfiguration(); configurationError = "角色配置错误：\(error.localizedDescription)" }
    }
    func showConfiguration() { chooseModel() }
    @objc func reloadModels() {
        guard pendingImport == nil else { return }
        readConfiguration()
        host.reload(selection: config.character)
        refreshUI()
    }
    @objc private func chooseModel() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.zip]; panel.allowsMultipleSelection = false
        panel.message = "选择你有权使用的本机 Live2D 模型 ZIP（最大 128 MiB）。验证成功后保存，下次启动自动载入。"
        guard panel.runModal() == .OK, let source = panel.url else { return }
        do { try importModel(from: source) }
        catch { configurationError = "模型导入失败：\(error.localizedDescription)"; refreshUI() }
    }
    /// Import is committed only after the existing data-only runtime validates and loads it.
    func importModel(from source: URL) throws {
        guard pendingImport == nil else { throw CocoaError(.fileWriteUnknown) }
        guard source.pathExtension.lowercased() == "zip" else { throw CocoaError(.fileReadCorruptFile) }
        let size = try source.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size > 0, size <= 128 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
        try FileManager.default.createDirectory(at: modelRoot, withIntermediateDirectories: true)
        let selection = CharacterModelSelection(identity: source.deletingPathExtension().lastPathComponent, relativePath: UUID().uuidString + ".zip")
        try FileManager.default.copyItem(at: source, to: modelRoot.appendingPathComponent(selection.relativePath))
        pendingImport = selection; configurationError = nil
        host.reload(selection: selection)
        refreshUI()
    }
    private func modelChanged() {
        onExpressionsChanged?(host.capabilities.expressions.filter { $0.lowercased() != "watermark" })
        if let pending = pendingImport {
            if host.loaded {
                pendingImport = nil
                do {
                    let next = CharacterModelConfiguration(character: pending)
                    try next.save(root: modelRoot)
                    config = next; configurationError = nil
                } catch {
                    configurationError = "模型配置保存失败：\(error.localizedDescription)"
                    host.reload(selection: config.character)
                    try? FileManager.default.removeItem(at: modelRoot.appendingPathComponent(pending.relativePath))
                }
            } else if let error = host.error {
                pendingImport = nil
                configurationError = "模型验证失败：" + error
                host.reload(selection: config.character)
                try? FileManager.default.removeItem(at: modelRoot.appendingPathComponent(pending.relativePath))
            }
        }
        refreshUI()
    }
    func setFeet(to point: CGPoint, facing: CGFloat) {
        self.facing = facing
        let size = Self.visualSize(height: preferredHeight)
        host.frame = CGRect(x: point.x-size.width/2,y:point.y,width:size.width,height:size.height)
        refreshUI()
    }
    func setMovementSpeedPointsPerSecond(_ speed: Double) { characterState.movementSpeed = max(0,speed) }
    func apply(activity: PetActivity) {
        characterState.activity = activity
        characterState.dragging = activity == .pickedUp
        let moving = characterState.movementSpeed > 1
        let semantic: CharacterAnimationState = activity == .pickedUp ? .dragged : activity == .falling ? .falling : moving ? (facing < 0 ? .walkLeft : .walkRight) : .idle
        if semantic != characterState.intent.state {
            apply(intent: CharacterAnimationIntent(state: semantic, source: .desktopInteraction))
        }
    }
    func apply(intent: CharacterAnimationIntent) {
        var timed = intent; timed.createdAt = elapsed
        // Native endDrag owns this transition; the old FSM compares priority before its landing exception.
        if currentIntent.state == .dragged && intent.state == .landing && intent.source == .desktopInteraction {
            timed.interruptPolicy = .alwaysInterrupt
        }
        if semanticMachine.apply(timed, now: elapsed) {
            characterState.intent = timed
            characterState.emotion = timed.emotion ?? .neutral
        }
    }
    func setSpeakingLevel(_ level: Float) { if level.isFinite { characterState.mouthOpenness = min(1,max(0,Double(level))) } }
    func setLookTarget(_ target: CGPoint?) { lookTarget = target }
    func update(deltaTime: TimeInterval) {
        elapsed += max(0,deltaTime)
        semanticMachine.update(now: elapsed)
        if let intent = semanticMachine.currentIntent { characterState.intent = intent }
        else if characterState.intent.state != semanticMachine.state {
            characterState.intent = CharacterAnimationIntent(state: semanticMachine.state, source: .desktopInteraction, createdAt: elapsed)
        }
        characterState.emotion = characterState.intent.emotion ?? .neutral
        if elapsed >= reactionEndsAt {
            characterState.reactionEmotion = nil
            characterState.reactionAction = nil
        }
        if elapsed >= expressionPreviewEndsAt { characterState.expressionPreview = nil }
        if let lookTarget { characterState.attentionTarget = lookTarget }
        else if let window { characterState.attentionTarget = convert(window.convertPoint(fromScreen: NSEvent.mouseLocation), from: nil) }
        host.apply(characterState)
        let now = Date.timeIntervalSinceReferenceDate
        host.refreshOccupancy(now:now)
        if let started = glyphStarted {
            let age = elapsed-started
            transientGlyph.isHidden = age >= glyphDuration
            transientGlyph.alphaValue = min(1,max(0,min(age/0.2,(glyphDuration-age)/0.3)))
            transientGlyph.frame.origin = CGPoint(x:host.frame.midX,y:host.frame.maxY+8+min(12,age*12))
            if age >= glyphDuration { glyphStarted = nil }
        }
    }
    func hitTestCharacter(_ point: CGPoint) -> Bool { visibility && host.hit(point) }
    func interactiveRegion(_ point: CGPoint) -> Bool {
        hitTestCharacter(point) || nativeUI(at:point) != nil
    }
    func nativeUI(at point: CGPoint) -> NSView? {
        guard visibility else { return nil }
        if !bubble.isHidden, bubble.frame.contains(point) { return bubble.hitTest(point) ?? bubble }
        return [hostPicker,retryButton,status].first { !$0.isHidden && $0.frame.contains(point) }
    }
    func routeCharacterHit(_ point: CGPoint) { host.sendHit(point) }
    func setVisible(_ visible: Bool, animated: Bool) {
        characterState.visible = visible; isHidden = !visible
        host.apply(characterState)
    }
    func setPaused(_ paused: Bool) { host.setPaused(paused) }
    func shutdown() { host.close() }
    func showBubble(_ text: String) {
        bubbleText = text
        bubble.isHidden = false; refreshUI()
    }
    func hideBubble() { bubbleText = nil; bubble.isHidden = true; onGeometryChanged?() }
    func dismissBubble() { hideBubble() }
    private func refreshUI() {
        let messages = [configurationError, host.error].compactMap { $0 }
        let setup = config.character == nil || !messages.isEmpty || pendingImport != nil
        status.isHidden = !setup
        status.stringValue = pendingImport != nil ? "正在验证模型…" : messages.isEmpty ? "选择一个 Live2D 模型，开始桌面陪伴。" : messages.joined(separator: "\n")
        let width = min(300,max(120,bounds.width-16))
        status.frame = CGRect(x:8,y:8,width:width,height:76)
        hostPicker.frame = CGRect(x:8,y:88,width:150,height:26)
        retryButton.frame = CGRect(x:166,y:88,width:100,height:26)
        for button in [hostPicker,retryButton] { button.isHidden = !setup; button.isEnabled = pendingImport == nil }
        if let bubbleText {
            let size = bubble.configure(text: bubbleText, availableWidth: bounds.width - 24)
            let character = visualBounds.isEmpty ? host.frame : visualBounds
            let placement = CompanionBubblePlacement.frame(size: size, character: character, within: bounds)
            bubble.arrowAtBottom = placement.above
            bubble.frame = placement.frame
            bubble.anchorX = character.midX - placement.frame.minX
        }
        badge.frame = CGRect(x:host.frame.midX-40,y:host.frame.maxY-20,width:100,height:20)
        studyBook.frame = CGRect(x:host.frame.midX-12,y:host.frame.maxY+6,width:24,height:24)
        onGeometryChanged?()
    }
    func setAccessories(_ items: Set<Accessory>) {
        // Equipment metadata remains native. A Live2D model must supply its own
        // wearable artwork; displaying an accessory name is not that artwork.
    }
    func setStudyMode(_ active: Bool) { studyActive = active; studyBook.isHidden = !active; updateBadge() }
    private func updateBadge() {
        badge.stringValue = studyActive ? "专注中" : ""
        badge.isHidden = !studyActive
    }
    func setFocusSpot(_ point: CGPoint?) { setLookTarget(point) }
    private func showGlyph(_ text: String, duration: TimeInterval = 1.3) {
        // Once a real facial expression is available, do not layer a fallback emoji on it.
        guard CharacterExpressionResolver.expression(for: characterState, available: host.capabilities.expressions) == nil else {
            transientGlyph.isHidden = true; glyphStarted = nil; return
        }
        transientGlyph.stringValue = text
        transientGlyph.frame.size = CGSize(width:36,height:30)
        glyphStarted = elapsed; glyphDuration = duration
    }
    func previewExpression(_ name: String?) {
        characterState.expressionPreview = name.flatMap { host.capabilities.expressions.contains($0) && $0.lowercased() != "watermark" ? $0 : nil }
        expressionPreviewEndsAt = elapsed + 5
    }
    func react(emotion: PetEmotion, action: PetAction) {
        characterState.expressionPreview = nil
        characterState.reactionEmotion = emotion
        characterState.reactionAction = action
        reactionEndsAt = elapsed + 4
        characterState.emotion = CharacterAnimationEmotion(petEmotion:emotion)
        let glyphs: [PetEmotion:String] = [.happy:"😊",.shy:"☺️",.sad:"🥺",.excited:"✨",.thinking:"💭",.sleepy:"😴"]
        if let glyph = glyphs[emotion] { showGlyph(glyph) }
        switch action {
        case .wave, .nod, .point, .cheer:
            apply(intent: CharacterAnimationIntent(state:.reacting,emotion:CharacterAnimationEmotion(petEmotion:emotion),priority:70,duration:0.55,source:.agentRuntime))
        case .read: playIdleIcon(.read)
        case .play: playIdleIcon(.play)
        case .none: break
        }
    }
    func playIdleIcon(_ kind: IdleKind) {
        switch kind {
        case .read: showGlyph("📖",duration:2.1)
        case .sleep: showGlyph("💤",duration:2.1)
        case .play: showGlyph("🎈",duration:2.1)
        }
    }
}
