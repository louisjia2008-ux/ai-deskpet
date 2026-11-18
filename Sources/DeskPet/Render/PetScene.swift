import SpriteKit
import SwiftUI
import AICore

/// SpriteKit scene hosting the production character renderer plus desktop companion overlays.
@MainActor
final class PetScene: SKScene, PetRenderer {

    private let character = StaticPNGCharacterRenderer(config: CharacterAnimationConfigLoader.loadDefault(),
                                                       characterID: "hatched-girl")
    private let overlayAnchor = SKNode()   // never flipped — hosts bubbles/icons
    private let dragon = SKNode()          // companion 小龙, independent position
    private let companionDragon = StaticPNGCharacterRenderer(config: CharacterAnimationConfigLoader.loadDefault(),
                                                             characterID: "hatched-dragon")
    private let dragonVectorArt = SKNode()
    // P22 — implicit-unwrapped optional so `init?(coder:)` doesn't have to
    // touch the renderer (NIB construction is unreachable; the trap lives
    // in `required init?(coder:)` below).
    private var dragonV1Renderer: StaticPNGDragonRenderer!
    private let accessoryLayer = SKNode()  // equipped accessories, child of character renderer
    private let nest = SKNode()            // Character V2 habitat anchor in a screen corner
    private let locomotion = CharacterLocomotionController()
    private var bubbleNode: SKNode?
    private var sceneElapsed: TimeInterval = 0
    private var currentFacing: CGFloat = 1
    private var currentSpeedPointsPerSecond: Double = 0
    private var previousDragonFeet: CGPoint?

    static let unscaledFootprint = CharacterAnimationConfig.default.footprint
    static let footprint = PetScaleController().visualSize(for: unscaledFootprint)
    static let companionDragonScale: CGFloat = 0.28
    static let dragonVisualSize = CGSize(width: 192.0 / 208.0 * unscaledFootprint.height * companionDragonScale,
                                         height: unscaledFootprint.height * companionDragonScale)

    override init(size: CGSize) {
        self.dragonV1Renderer = StaticPNGDragonRenderer()
        super.init(size: size)
        configureScene()
    }

    init(size: CGSize, dragonV1Renderer: StaticPNGDragonRenderer) {
        self.dragonV1Renderer = dragonV1Renderer
        super.init(size: size)
        configureScene()
    }

    // PetScene is constructed programmatically in code; the NIB path is
    // unreachable. SpriteKit's protocol requires the symbol — make it an
    // explicit trap only if it ever fires, but don't crash the process on
    // `init?(coder:)` from a non-existent storyboard.
    required init?(coder: NSCoder) {
        assertionFailure("PetScene is not NIB-loadable; use init(size:)")
        super.init(coder: coder)
    }

    private func configureScene() {
        scaleMode = .resizeFill
        backgroundColor = .clear
        buildCharacter()
        buildDragon()
        buildDragonV1Renderer()
        buildNest()
        addChild(nest)
        addChild(dragon)
        addChild(character)
        addChild(overlayAnchor)
    }

    // MARK: PetRenderer

    func setFeet(to point: CGPoint, facing: CGFloat) {
        character.setFeet(to: point, facing: facing)
        overlayAnchor.position = point
        currentFacing = facing < 0 ? -1 : 1
    }

    func setMovementSpeedPointsPerSecond(_ speed: Double) {
        currentSpeedPointsPerSecond = max(0, speed)
    }

    // P22 — focus-spot behaviour. When a focus session starts the pet
    // walks toward `point` (typically the screen-bottom-centre anchor near
    // the main window) and stays there for the duration of the session.
    // `nil` clears the anchor and re-enables idle wander.
    //
    // Implementation: we just clamp the locomotion speed to 0 while the
    // anchor is non-nil and let the existing `setFeet` walk-to-edge do the
    // arrival (the pet reaches the anchor on its next idle-wander target,
    // then stays there). For full sub-second precision a target queue is
    // needed; this version is a pragmatic step-1 that visibly stops the pet
    // at the focus spot without rewriting the locomotion FSM.
    private var focusSpot: CGPoint?

    func setFocusSpot(_ point: CGPoint?) {
        focusSpot = point
        if let point {
            // Move the pet to the focus anchor immediately if it's already
            // close (within 80pt); otherwise let the existing wander step
            // bring it closer next tick.
            let feet = character.position
            if hypot(feet.x - point.x, feet.y - point.y) < 80 {
                setFeet(to: point, facing: 1)
            }
            currentSpeedPointsPerSecond = 0
        } else {
            currentSpeedPointsPerSecond = 5  // resume idle drift
        }
    }

    /// Position the companion dragon (window-local feet point) and orient it.
    func setDragonFeet(to point: CGPoint, facing: CGFloat) {
        let delta = previousDragonFeet.map { CGPoint(x: point.x - $0.x, y: point.y - $0.y) } ?? .zero
        let moving = hypot(delta.x, delta.y) > 0.35
        dragonV1Renderer.applyMotion(horizontalDelta: delta.x, moving: moving, facing: facing)
        companionDragon.apply(intent: CharacterAnimationIntent(
            state: moving ? (facing < 0 ? .walkLeft : .walkRight) : .idle,
            priority: moving ? 35 : 5,
            source: .desktopInteraction,
            createdAt: sceneElapsed))
        previousDragonFeet = point
        dragon.position = point
        dragon.xScale = abs(dragon.xScale) * (facing < 0 ? -1 : 1)
        dragon.yScale = abs(dragon.yScale)
    }

    func apply(activity: PetActivity) {
        switch activity {
        case .pickedUp:
            locomotion.cancel()
            character.apply(intent: CharacterAnimationIntent(state: .dragged, priority: 90,
                                                             source: .desktopInteraction,
                                                             createdAt: sceneElapsed))
        case .falling:
            locomotion.cancel()
            character.apply(intent: CharacterAnimationIntent(state: .falling, priority: 80,
                                                             duration: 0.35,
                                                             source: .desktopInteraction,
                                                             createdAt: sceneElapsed))
        case .idle, .wander, .recalling:
            if let intent = locomotion.update(activity: activity,
                                              facing: currentFacing,
                                              speedPointsPerSecond: currentSpeedPointsPerSecond,
                                              now: sceneElapsed) {
                character.apply(intent: intent)
            }
        }
    }

    func apply(intent: CharacterAnimationIntent) {
        character.apply(intent: intent)
    }

    func setSpeakingLevel(_ level: Float) {
        character.setSpeakingLevel(level)
    }

    func setLookTarget(_ target: CGPoint?) {
        character.setLookTarget(target)
    }

    func update(deltaTime: TimeInterval) {
        sceneElapsed += deltaTime
        if let intent = locomotion.tick(now: sceneElapsed) {
            character.apply(intent: intent)
        }
        // Re-assert the walk visual after a higher-priority one-shot (jump p68 / taskFailed p70 /
        // greet p44 / cancel-idle) expired mid-walk or replaced the agent-sustained state. The
        // renderer FSM (p35 walk < p45+ agent intent) rejects this while a legit higher-priority
        // intent is still active, so we self-heal at most once per frame without clobbering
        // transient overrides.
        if locomotion.isWalking, !character.animationState.isLocomotionVisual,
           let intent = locomotion.reassertWalkingIntent(now: sceneElapsed) {
            character.apply(intent: intent)
        }
        character.update(deltaTime: deltaTime)
        companionDragon.update(deltaTime: deltaTime)
        dragonV1Renderer.update(deltaTime: deltaTime)
        synchronizeDragonArtMode()
    }

    func hitTestCharacter(_ point: CGPoint) -> Bool {
        character.hitTest(point)
    }

    func setVisible(_ visible: Bool, animated: Bool) {
        character.setVisible(visible, animated: animated)
    }

    func shutdown() {
        character.shutdown()
        companionDragon.shutdown()
    }

    func diagnostics() -> CharacterAnimationDiagnostics {
        character.diagnostics()
    }

    #if DEBUG
    func dragonDiagnosticsForTests() -> DragonAnimationDiagnostics {
        dragonV1Renderer.diagnostics()
    }

    func companionDragonDiagnosticsForTests() -> CharacterAnimationDiagnostics {
        companionDragon.diagnostics()
    }
    #endif

    // MARK: Build

    private func buildCharacter() {
        do {
            try character.load()
        } catch {
            character.apply(intent: CharacterAnimationIntent(state: .unavailable,
                                                             priority: 100,
                                                             source: .rendererFallback))
        }
        character.setScale(PetScaleController().scaleFactor(for: Self.unscaledFootprint))
        character.addChild(accessoryLayer)
    }

    // MARK: Companion dragon

    private func buildDragon() {
        let green = SKColor(calibratedRed: 0.55, green: 0.82, blue: 0.62, alpha: 1)
        let belly = SKShapeNode(path: CGPath(ellipseIn: CGRect(x: -20, y: 0, width: 40, height: 36), transform: nil))
        belly.fillColor = green
        belly.strokeColor = green.blended(withFraction: 0.3, of: .black) ?? green
        belly.lineWidth = 3

        for dx in [-8.0, 8.0] {
            let eye = SKShapeNode(circleOfRadius: 4)
            eye.position = CGPoint(x: dx, y: 22)
            eye.fillColor = .white
            eye.strokeColor = .clear
            let pupil = SKShapeNode(circleOfRadius: 2)
            pupil.fillColor = .black; pupil.strokeColor = .clear
            eye.addChild(pupil)
            belly.addChild(eye)
        }
        for sx in [-1.0, 1.0] {
            let wing = SKShapeNode(path: CGPath(ellipseIn: CGRect(x: -10, y: 0, width: 20, height: 12), transform: nil))
            wing.fillColor = green.withAlphaComponent(0.85)
            wing.strokeColor = .clear
            wing.position = CGPoint(x: sx * 18, y: 18)
            wing.zRotation = sx * .pi / 6
            belly.addChild(wing)
        }
        dragonVectorArt.addChild(belly)
        dragon.addChild(dragonVectorArt)
        // Gentle hover bob so it reads as flying/floating (doc §3.4 略显笨拙).
        let bob = SKAction.sequence([.moveBy(x: 0, y: 5, duration: 0.9), .moveBy(x: 0, y: -5, duration: 0.9)])
        bob.timingMode = .easeInEaseOut
        belly.run(.repeatForever(bob))
    }

    private func buildDragonV1Renderer() {
        do {
            try companionDragon.load()
        } catch {
            companionDragon.apply(intent: CharacterAnimationIntent(state: .unavailable,
                                                                   priority: 100,
                                                                   source: .rendererFallback))
        }
        companionDragon.setScale(Self.companionDragonScale)
        dragon.addChild(companionDragon)

        dragonV1Renderer.loadIfEnabled()
        dragonV1Renderer.position = .zero
        dragon.addChild(dragonV1Renderer)
        synchronizeDragonArtMode()
    }

    private func synchronizeDragonArtMode() {
        let hatchedDragonLoaded = companionDragon.diagnostics().resourceLoaded
        companionDragon.isHidden = !hatchedDragonLoaded
        dragonVectorArt.isHidden = hatchedDragonLoaded || dragonV1Renderer.isActive
        dragonV1Renderer.isHidden = hatchedDragonLoaded || !dragonV1Renderer.isActive
    }

    // MARK: Accessories (doc §10.3)

    func setAccessories(_ items: Set<Accessory>) {
        accessoryLayer.removeAllChildren()
        let pink = SKColor(calibratedRed: 0.98, green: 0.66, blue: 0.78, alpha: 1)
        let blue = SKColor(calibratedRed: 0.45, green: 0.62, blue: 0.95, alpha: 1)
        for a in items {
            switch a {
            case .hairclip:
                let clip = SKShapeNode(rect: CGRect(x: -28, y: 96, width: 12, height: 5), cornerRadius: 2)
                clip.fillColor = pink; clip.strokeColor = .clear; accessoryLayer.addChild(clip)
            case .glasses:
                for dx in [-14.0, 14.0] {
                    let g = SKShapeNode(circleOfRadius: 8)
                    g.position = CGPoint(x: dx, y: 80); g.strokeColor = blue; g.lineWidth = 2; g.fillColor = .clear
                    accessoryLayer.addChild(g)
                }
            case .badge:
                let b = SKShapeNode(circleOfRadius: 5); b.position = CGPoint(x: -16, y: 40)
                b.fillColor = .systemYellow; b.strokeColor = .clear; accessoryLayer.addChild(b)
            case .scarf:
                let s = SKShapeNode(rect: CGRect(x: -26, y: 50, width: 52, height: 9), cornerRadius: 4)
                s.fillColor = pink; s.strokeColor = .clear; accessoryLayer.addChild(s)
            case .cape:
                let c = SKShapeNode(rect: CGRect(x: -30, y: 6, width: 60, height: 56), cornerRadius: 10)
                c.fillColor = blue.withAlphaComponent(0.5); c.strokeColor = .clear; c.zPosition = -1
                accessoryLayer.addChild(c)
            case .nightcap:
                let cap = SKShapeNode(path: trianglePath(w: 40, h: 30, y: 104))
                cap.fillColor = blue; cap.strokeColor = .clear; accessoryLayer.addChild(cap)
            case .dragonCollar:
                let collar = SKShapeNode(rect: CGRect(x: -16, y: 2, width: 32, height: 5), cornerRadius: 2)
                collar.fillColor = pink; collar.strokeColor = .clear
                dragon.childNode(withName: "collar")?.removeFromParent()
                collar.name = "collar"; dragon.addChild(collar)
            }
        }
        if !items.contains(.dragonCollar) { dragon.childNode(withName: "collar")?.removeFromParent() }
    }

    private func trianglePath(w: CGFloat, h: CGFloat, y: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: -w/2, y: y)); p.addLine(to: CGPoint(x: w/2, y: y))
        p.addLine(to: CGPoint(x: 0, y: y + h)); p.closeSubpath(); return p
    }

    // MARK: Character V2 habitat anchor

    private func buildNest() {
        let shadow = SKShapeNode(ellipseOf: CGSize(width: 102, height: 20))
        shadow.fillColor = SKColor(calibratedRed: 0.09, green: 0.13, blue: 0.22, alpha: 0.16)
        shadow.strokeColor = .clear
        shadow.position = CGPoint(x: 0, y: -4)

        let platform = SKShapeNode(ellipseOf: CGSize(width: 92, height: 32))
        platform.fillColor = SKColor(calibratedRed: 0.80, green: 0.91, blue: 1.0, alpha: 0.92)
        platform.strokeColor = SKColor(calibratedRed: 0.42, green: 0.62, blue: 0.95, alpha: 0.7)
        platform.lineWidth = 2

        let book = SKShapeNode(path: habitatBookPath())
        book.fillColor = SKColor(calibratedRed: 0.93, green: 0.98, blue: 1.0, alpha: 0.96)
        book.strokeColor = SKColor(calibratedRed: 0.38, green: 0.55, blue: 0.88, alpha: 0.78)
        book.lineWidth = 1.4
        book.position = CGPoint(x: 0, y: 15)

        let ribbon = SKShapeNode(rect: CGRect(x: -3, y: 11, width: 6, height: 18), cornerRadius: 2)
        ribbon.fillColor = SKColor(calibratedRed: 0.52, green: 0.70, blue: 1.0, alpha: 0.8)
        ribbon.strokeColor = .clear

        let star = SKShapeNode(path: habitatStarPath(radius: 6))
        star.fillColor = SKColor(calibratedRed: 1.0, green: 0.89, blue: 0.43, alpha: 0.95)
        star.strokeColor = .clear
        star.position = CGPoint(x: 34, y: 24)

        nest.addChild(shadow)
        nest.addChild(platform)
        nest.addChild(book)
        nest.addChild(ribbon)
        nest.addChild(star)
        nest.alpha = 0.0
        nest.setScale(0.85)
    }

    /// Place + show/hide the nest (window-local). It is hidden by default because the pet overlay
    /// window follows the character; drawing a habitat here would make the habitat follow too.
    func configureNest(enabled: Bool, at point: CGPoint, visible: Bool = false) {
        nest.position = point
        nest.isHidden = !(enabled && visible)
        nest.alpha = enabled && visible ? 0.35 : 0.0
    }
    func setNestExpanded(_ expanded: Bool) {
        guard nest.alpha > 0 else { return }
        nest.run(.group([.fadeAlpha(to: expanded ? 0.95 : 0.35, duration: 0.2),
                         .scale(to: expanded ? 1.0 : 0.85, duration: 0.2)]))
    }

    private func habitatBookPath() -> CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: -30, y: 0))
        path.addQuadCurve(to: CGPoint(x: 0, y: -2), control: CGPoint(x: -16, y: 7))
        path.addQuadCurve(to: CGPoint(x: 30, y: 0), control: CGPoint(x: 16, y: 7))
        path.addLine(to: CGPoint(x: 26, y: 18))
        path.addQuadCurve(to: CGPoint(x: 0, y: 15), control: CGPoint(x: 13, y: 20))
        path.addQuadCurve(to: CGPoint(x: -26, y: 18), control: CGPoint(x: -13, y: 20))
        path.closeSubpath()
        return path
    }

    private func habitatStarPath(radius: CGFloat) -> CGPath {
        let path = CGMutablePath()
        for i in 0..<10 {
            let angle = CGFloat(i) * .pi / 5 - .pi / 2
            let r = i.isMultiple(of: 2) ? radius : radius * 0.45
            let point = CGPoint(x: cos(angle) * r, y: sin(angle) * r)
            if i == 0 { path.move(to: point) } else { path.addLine(to: point) }
        }
        path.closeSubpath()
        return path
    }

    /// A brief two-character moment (doc §3.4 双角色互动).
    func playDuet() {
        let hearts = SKLabelNode(text: ["🤍", "🐉", "✨"].randomElement()!)
        hearts.fontSize = 18
        hearts.position = CGPoint(x: -30, y: Self.footprint.height * 0.5)
        hearts.alpha = 0
        overlayAnchor.addChild(hearts)
        hearts.run(.sequence([.group([.fadeIn(withDuration: 0.2), .moveBy(x: 0, y: 16, duration: 1.0)]),
                             .fadeOut(withDuration: 0.3), .removeFromParent()]))
    }

    // MARK: Speech bubble (doc §8.2 — short, non-focus-stealing)

    /// P17 / CR-01 — wraps the input into a bounded multi-line bubble, truncates with an
    /// ellipsis when it exceeds the cap, and tints via DS tokens so light/dark mode
    /// stays correct. Pure presentation change; the FSM / asset pipeline is untouched.
    func showBubble(_ text: String) {
        hideBubble()
        let layout = SpeechBubbleLayout.lines(for: text,
                                              maxWidth: Self.bubbleMaxWidth,
                                              maxLines: Self.bubbleMaxLines)
        let joined = layout.lines.joined(separator: "\n")
        let label = SKLabelNode(text: joined)
        label.fontName = "PingFangSC-Regular"
        label.fontSize = 15
        label.numberOfLines = layout.lines.count
        label.preferredMaxLayoutWidth = Self.bubbleMaxWidth
        label.lineBreakMode = .byTruncatingTail
        label.fontColor = Self.resolvedTextColor()
        label.verticalAlignmentMode = .center
        label.horizontalAlignmentMode = .center

        let pad: CGFloat = 12
        let measured = (joined as NSString).size(withAttributes: [
            .font: NSFont(name: label.fontName ?? "PingFangSC-Regular", size: label.fontSize)
                ?? NSFont.systemFont(ofSize: label.fontSize)
        ])
        let measuredWidth = min(Self.bubbleMaxWidth, measured.width)
        let measuredHeight = measured.height
        let w = max(60, measuredWidth + pad * 2)
        let h = measuredHeight + pad * 1.5
        let bg = SKShapeNode(rect: CGRect(x: -w/2, y: -h/2, width: w, height: h), cornerRadius: 10)
        bg.fillColor = Self.resolvedBubbleFill()
        bg.strokeColor = Self.resolvedBubbleStroke()
        bg.lineWidth = 1.5
        bg.addChild(label)

        let node = SKNode()
        node.position = CGPoint(x: 0, y: Self.footprint.height + 24)
        node.addChild(bg)
        node.alpha = 0
        node.setScale(0.8)
        overlayAnchor.addChild(node)
        node.run(.group([.fadeIn(withDuration: 0.18), .scale(to: 1, duration: 0.18)]))
        bubbleNode = node
    }

    func hideBubble() {
        guard let node = bubbleNode else { return }
        bubbleNode = nil
        node.run(.sequence([.fadeOut(withDuration: 0.18), .removeFromParent()]))
    }

    /// P17 / CR-01 — bubble max width / max lines. Matches the on-screen character footprint
    /// so long replies no longer overflow the desktop.
    private static let bubbleMaxWidth: CGFloat = 320
    private static let bubbleMaxLines: Int = 4

    /// Resolve the bubble text color via DSPalette so it stays correct in dark mode.
    private static func resolvedTextColor() -> SKColor {
        let rgba = DSPalette.resolved(.textPrimary,
                                      scheme: currentScheme(),
                                      increaseContrast: false,
                                      reduceTransparency: false)
        return SKColor(srgbRed: rgba.r, green: rgba.g, blue: rgba.b, alpha: rgba.a)
    }

    private static func resolvedBubbleFill() -> SKColor {
        let rgba = DSPalette.resolved(.elevatedSurface,
                                      scheme: currentScheme(),
                                      increaseContrast: false,
                                      reduceTransparency: false)
        return SKColor(srgbRed: rgba.r, green: rgba.g, blue: rgba.b, alpha: min(0.98, rgba.a + 0.02))
    }

    private static func resolvedBubbleStroke() -> SKColor {
        let rgba = DSPalette.resolved(.primaryAccent,
                                      scheme: currentScheme(),
                                      increaseContrast: false,
                                      reduceTransparency: false)
        return SKColor(srgbRed: rgba.r, green: rgba.g, blue: rgba.b, alpha: min(1, rgba.a + 0.2))
    }

    private static func currentScheme() -> ColorScheme {
        NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .dark : .light
    }

    /// Light-companion study mode during a focus session (doc §9.5): a steady book over the
    /// girl, dragon shows zzz. Stays until turned off.
    /// P17 / NM-06 — emoji glyphs replaced with SF Symbol textures (template-tinted).
    func setStudyMode(_ on: Bool) {
        overlayAnchor.childNode(withName: "study")?.removeFromParent()
        dragon.childNode(withName: "dragonSleep")?.removeFromParent()
        guard on else { return }
        if let bookTexture = Self.symbolTexture(named: "book.fill", size: CGSize(width: 24, height: 24)) {
            let book = SKSpriteNode(texture: bookTexture)
            book.name = "study"
            book.position = CGPoint(x: 0, y: Self.footprint.height + 6)
            overlayAnchor.addChild(book)
        }
        if let zzzTexture = Self.symbolTexture(named: "zzz", size: CGSize(width: 20, height: 18)) {
            let zzz = SKSpriteNode(texture: zzzTexture)
            zzz.name = "dragonSleep"
            zzz.position = CGPoint(x: 0, y: 44)
            dragon.addChild(zzz)
        }
    }

    /// Render an SF Symbol to an `SKTexture` using `NSImage`. Returns nil if the symbol
    /// is unavailable on this OS so the caller falls back gracefully.
    private static func symbolTexture(named name: String,
                                      size: CGSize,
                                      weight: NSFont.Weight = .regular) -> SKTexture? {
        let config = NSImage.SymbolConfiguration(pointSize: max(size.width, size.height),
                                                 weight: weight)
        guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
                .withSymbolConfiguration(config) else { return nil }
        let canvas = NSImage(size: size)
        canvas.lockFocus()
        let drawRect = NSRect(origin: .zero, size: size)
        base.draw(in: drawRect,
                  from: NSRect(origin: .zero, size: base.size),
                  operation: .sourceOver,
                  fraction: 1.0)
        canvas.unlockFocus()
        return SKTexture(image: canvas)
    }

    /// React to a structured AI reply (doc §11.5): a brief emotion glyph + a small action motion.
    func react(emotion: PetEmotion, action: PetAction) {
        let glyph: String
        switch emotion {
        case .happy: glyph = "😊"
        case .shy: glyph = "☺️"
        case .sad: glyph = "🥺"
        case .excited: glyph = "✨"
        case .thinking: glyph = "💭"
        case .sleepy: glyph = "😴"
        case .neutral: glyph = ""
        }
        if !glyph.isEmpty { floatGlyph(glyph) }

        switch action {
        case .wave, .nod, .point:
            character.apply(intent: CharacterAnimationIntent(state: .reacting,
                                                             emotion: .curious,
                                                             intensity: 0.45,
                                                             priority: 70,
                                                             duration: 0.45,
                                                             source: .agentRuntime))
        case .cheer:
            character.apply(intent: CharacterAnimationIntent(state: .reacting,
                                                             emotion: .happy,
                                                             intensity: 0.75,
                                                             priority: 70,
                                                             duration: 0.55,
                                                             source: .agentRuntime))
        case .read: playIdleIcon(.read)
        case .play: playIdleIcon(.play)
        case .none: break
        }
    }

    private func floatGlyph(_ g: String) {
        let label = SKLabelNode(text: g)
        label.fontSize = 20
        label.position = CGPoint(x: 16, y: Self.footprint.height + 8)
        label.alpha = 0
        overlayAnchor.addChild(label)
        label.run(.sequence([.group([.fadeIn(withDuration: 0.15), .moveBy(x: 0, y: 12, duration: 1.0)]),
                             .fadeOut(withDuration: 0.3), .removeFromParent()]))
    }

    /// Brief icon for self-entertainment (read/sleep/play), doc §8.1.
    func playIdleIcon(_ kind: IdleKind) {
        let glyph: String
        switch kind {
        case .read: glyph = "📖"
        case .sleep: glyph = "💤"
        case .play: glyph = "🎈"
        }
        let label = SKLabelNode(text: glyph)
        label.fontSize = 22
        label.position = CGPoint(x: 0, y: Self.footprint.height + 10)
        label.alpha = 0
        overlayAnchor.addChild(label)
        label.run(.sequence([.fadeIn(withDuration: 0.2),
                             .wait(forDuration: 1.6),
                             .fadeOut(withDuration: 0.3),
                             .removeFromParent()]))
    }
}
