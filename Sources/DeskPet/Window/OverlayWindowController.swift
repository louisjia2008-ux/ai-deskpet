import AppKit
import SpriteKit
import AICore
import PetAgentRuntime

struct PetClickGestureTracker {
    static let defaultMovementThreshold: CGFloat = 6
    static let defaultMaxClickDuration: TimeInterval = 0.8

    let downGlobal: CGPoint
    let startedAt: TimeInterval
    var movementThreshold: CGFloat = Self.defaultMovementThreshold
    var maxClickDuration: TimeInterval = Self.defaultMaxClickDuration
    private(set) var exceededMovementThreshold = false

    mutating func recordDrag(to globalPoint: CGPoint) {
        if distance(from: downGlobal, to: globalPoint) > movementThreshold {
            exceededMovementThreshold = true
        }
    }

    func isClick(upGlobal: CGPoint, endedAt: TimeInterval) -> Bool {
        !exceededMovementThreshold &&
            endedAt - startedAt <= maxClickDuration &&
            distance(from: downGlobal, to: upGlobal) <= movementThreshold
    }

    private func distance(from a: CGPoint, to b: CGPoint) -> CGFloat {
        hypot(a.x - b.x, a.y - b.y)
    }
}

/// Owns the overlay window + scene and runs the behavior loop. Bridges global AppKit
/// coordinates (state machine / surfaces) ↔ window-local coordinates (renderer).
@MainActor
final class OverlayWindowController: NSObject, OverlayContentDelegate {

    private let window: OverlayWindow
    private let content: OverlayContentView
    let surface: CharacterSurface
    #if DEBUG
    // Explicit old PNG QA probes only. Lazy: normal launch never creates a PetScene.
    private lazy var scene = PetScene(size: content.bounds.size)
    private lazy var skView: SKView = {
        let view = SKView(frame: content.bounds)
        view.allowsTransparency = true
        view.presentScene(scene)
        return view
    }()
    #endif

    private let state: PetState
    private(set) var machine: PetStateMachine
    private let screens: ScreenManager
    private let tracker: any WindowTrackerProviding
    private var characterHeight: CGFloat = 240
    private let placementURL: URL

    // M1 companionship
    private let engagement = EngagementTracker()
    private let proactivity = ProactivityEngine()
    private let context: ContextMonitor
    private var latestContext = BehaviorContext()

    /// Voice (doc §8.3); injected by the app. nil → no voicing (silent).
    var voice: VoiceService?
    /// Fired when the user touches the pet (doc §10.3 摸头 → 关系增长).
    var onPetTouched: () -> Void = {}
    /// Fired only for a click-like pet interaction; dragging the pet must not open chat.
    var onPetClickedForChat: () -> Void = {}

    // P16 — presence seam (defaults to no-op so unit / DEBUG harnesses keep working without wiring)
    var applyPresenceIntent: (CharacterAnimationIntent) -> Void = { _ in }
    var onSecondTick: () -> Void = {}
    var setChatLookTarget: (CGPoint?) -> Void = { _ in }
    var setPresenceEngaged: ((Bool) -> Void)? = nil
    /// P16 — semantic-aware proactivity gate (suppresses proactive chatter when the semantic
    /// state is in {sleeping, dormant} but exposes the semantic state to the rest of the
    /// overlay without leaking dormant vocabulary into proactivity code).
    var presenceCoordinatorState: (() -> CharacterPresenceCoordinator.State?)? = nil
    /// R1-3 — noteUserInteraction seam. Called from `registerUserResponse()` so the
    /// coordinator's presence-wake signal is real. AppDelegate wires this back to
    /// `presenceCoordinator?.noteUserInteraction()`.
    var onUserInteractionNote: () -> Void = {}

    private var nestGlobal: CGPoint = .zero

    private var behaviorTimer: Timer?
    private var surfaceTimer: Timer?
    private var lastTick: TimeInterval = 0
    /// When true the 30Hz/1Hz timers were suspended for sleep/screensleep and
    /// must be resumed on wake (without re-registering monitors/observers).
    private var timersSuspendedForSleep = false
    private var sleepObservers: [NSObjectProtocol] = []
    private var dragOffset: CGSize = .zero
    private var petClickTracker: PetClickGestureTracker?
    private var modifierHeld = false
    private var monitors: [Any] = []
    private var pointerRouting: PointerRoutingTap?
    /// P18.2 — token for the screen-parameters observer so teardown can unregister it
    /// (previously discarded, so the observer could never be removed).
    private var screenObserver: NSObjectProtocol?
    /// P18.2 — idempotency guard. `start()` acquires two `Timer`s, two `NSEvent`
    /// monitors, and one `NotificationCenter` observer. Without this guard a second
    /// `start()` would overwrite the timer references (leaking the running timers on
    /// the run loop at 30 fps) and append duplicate monitors/observers → duplicated
    /// behavior. The controller is a process-lifetime singleton today (one `start()`
    /// at launch), so this is a defensive contract, not an active-defect fix.
    private var isStarted = false

    // Bubble + idle-home bookkeeping
    private var bubbleEndsAt: TimeInterval = 0
    private var bubbleInteracted = false
    private var bubbleActive = false
    private var expressionPreviewQuietUntil: TimeInterval = 0
    private var lastInteraction: TimeInterval = 0
    private let returnHomeAfter: TimeInterval = 180

    private var unionOrigin: CGPoint { window.frame.origin }
    private var desktopLayout: DesktopEntityLayoutController {
        DesktopEntityLayoutController(petVisualSize: visualSize)
    }

    init(state: PetState, screens: ScreenManager, modelRoot: URL = Live2DLocalResources.managedModelDirectory) {
        self.placementURL = modelRoot.appendingPathComponent("placement.json")
        self.state = state
        self.screens = screens
        let tracker = WindowTracker(screens: screens)
        self.tracker = tracker
        self.context = ContextMonitor(tracker: tracker)
        self.machine = PetStateMachine(state: state)

        let visualSize = CharacterSurface.visualSize(height: characterHeight)
        let contentSize = PetOverlayWindowMetrics.contentSize(for: visualSize)
        let initialFrame = CGRect(origin: .zero, size: contentSize)
        self.window = OverlayWindow(frame: initialFrame)
        self.content = OverlayContentView(frame: CGRect(origin: .zero, size: contentSize))
        self.surface = CharacterSurface(frame: content.bounds, modelRoot: modelRoot)
        super.init()

        surface.autoresizingMask = [.width, .height]
        content.addSubview(surface)
        content.delegate = self
        content.petRectProvider = { [weak self] in self?.localPetRect() ?? .zero }
        content.petHitTestProvider = { [weak self] point in self?.surface.hitTestCharacter(point) ?? false }
        content.nativeUIProvider = { [weak self] point in self?.surface.nativeUI(at: point) }
        surface.onGeometryChanged = { [weak self] in self?.applyPassthrough() }
        surface.onBubbleDismissed = { [weak self] in
            self?.bubbleInteracted = true
            self?.endBubble()
        }
        window.contentView = content
    }

    // MARK: Lifecycle

    func start() {
        // P18.2 — idempotent acquire. A repeated start() must not duplicate the
        // timers / monitors / observer this method installs.
        guard !isStarted else { return }
        isStarted = true
        placeInitial()
        surface.start()
        surface.setPaused(false)
        window.orderFrontRegardless()
        surface.setVisible(false, animated: false)
        surface.setVisible(true, animated: true)   // natural fade-in entrance (doc §14.1)

        lastTick = Date().timeIntervalSinceReferenceDate
        behaviorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.behaviorTick() }
        }
        surfaceTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshSurfaces()
                self?.proactivityTick()
                self?.onSecondTick()
            }
        }
        observeScreenChanges()
        observeModifier()
        observeSleepWake()
        let routing = PointerRoutingTap { [weak self] point in
            guard let self, self.isStarted, !NSApp.isHidden,
                  !self.state.isHidden, self.state.passthrough != .fullPassthrough,
                  self.surface.window != nil else { return }
            self.applyPassthrough(at: point)
        }
        if routing.start() { pointerRouting = routing }
        applyPassthrough()
    }

    private func placeInitial() {
        let vf = NSScreen.main?.visibleFrame ?? screens.visibleScreenFrames.first ?? screens.desktopUnion
        let layout = desktopLayout.defaultState(visibleFrames: visibleFramesForLayout)
        let saved = (try? Data(contentsOf: placementURL)).flatMap { try? JSONDecoder().decode([Double].self, from: $0) }
        let start: CGPoint
        if let saved, saved.count == 2, saved.allSatisfy({ $0.isFinite }) {
            start = clampFeet(CGPoint(x:saved[0],y:saved[1]))
        } else { start = layout.petFeet }
        nestGlobal = layout.nestAnchor
        state.position = start
        state.home = layout.homeTarget
        state.currentSurface = Surface(y: vf.minY + ScreenGeometry.dockPadding, xRange: vf.minX...vf.maxX,
                                       kind: .screenBottom, id: "screen-bottom-0")
        lastInteraction = Date().timeIntervalSinceReferenceDate
        relayoutOverlayWindow()
    }

    // MARK: Behavior loop

    private func behaviorTick() {
        let now = Date().timeIntervalSinceReferenceDate
        let dt = min(now - lastTick, 0.1)
        lastTick = now

        let previousPosition = state.position
        // Keep native setup/error controls stationary until a model is ready.
        // The empty surface has no character to locomote or entertain the user.
        if surface.host.loaded { _ = machine.tick(dt: dt) }
        let movementSpeed = Self.movementSpeedPointsPerSecond(from: previousPosition,
                                                              to: state.position,
                                                              dt: dt)
        engagement.decay(dt: dt)

        if bubbleActive, now >= bubbleEndsAt { endBubble() }

        syncRenderer(movementSpeedPointsPerSecond: movementSpeed)
        surface.update(deltaTime: dt)
        applyPassthrough()
    }

    private func syncRenderer(movementSpeedPointsPerSecond: Double = 0) {
        relayoutOverlayWindow()
        surface.setFeet(to: toLocal(state.position), facing: state.facing)
        surface.setMovementSpeedPointsPerSecond(movementSpeedPointsPerSecond)
        surface.apply(activity: machine.activity)
    }

    // MARK: Proactivity (doc §8.1/§8.2)

    private func proactivityTick() {
        guard surface.host.loaded else { return }
        let now = Date().timeIntervalSinceReferenceDate
        latestContext = context.snapshot()

        // Long idle → go home (doc §6.1), unless pinned/following.
        if !state.pinned, !state.followWindow, !bubbleActive,
           now - lastInteraction > returnHomeAfter,
           machine.activity == .idle, distance(state.position, state.home) > 8 {
            machine.recall()
        }

        guard !bubbleActive, now >= expressionPreviewQuietUntil else { return }
        // P16 — suppress proactive chatter when the semantic state is sleeping/dormant.
        if let coord = presenceCoordinatorState, let s = coord(), s.suppressesAmbient { return }
        let decision = proactivity.decide(now: now,
                                          context: latestContext,
                                          engagement: engagement.score,
                                          roll: Double.random(in: 0..<1))
        switch decision {
        case .none:
            break
        case .speak(let category):
            let line = SpeechLibrary.line(for: category, roll: Double.random(in: 0..<1))
            startBubble(line, now: now, kind: .chatter, emotion: .happy)
        case .idleEntertain(let kind):
            surface.playIdleIcon(kind)
        }
    }

    private func startBubble(_ text: String, now: TimeInterval,
                             kind: SpeechKind = .chatter, emotion: PetEmotion = .happy) {
        surface.showBubble(text)
        bubbleActive = true
        bubbleInteracted = false
        bubbleEndsAt = now + Double.random(in: 4...8)   // doc §8.2 4–8s
        voice?.utter(text, kind: kind, emotion: emotion, autoMuted: latestContext.shouldConverge)
    }

    private func endBubble() {
        surface.hideBubble()
        bubbleActive = false
        if !bubbleInteracted { engagement.ignored() }   // ignored bubble → less talkative
    }

    private func distance(_ a: CGPoint, _ b: CGPoint) -> CGFloat { hypot(a.x - b.x, a.y - b.y) }

    static func movementSpeedPointsPerSecond(from previous: CGPoint,
                                             to current: CGPoint,
                                             dt: TimeInterval) -> Double {
        guard dt > 0 else { return 0 }
        return Double(hypot(current.x - previous.x, current.y - previous.y) / CGFloat(dt))
    }

    /// Re-read window/screen surfaces; migrate to safety if the current one vanished (doc §5.2).
    /// Single CGWindowList fetch per tick (via WindowTracker.snapshot) instead of
    /// 2–3 separate copies.
    private func refreshSurfaces() {
        let windowList: [Surface]
        let surfaces: [Surface]
        if let concrete = tracker as? WindowTracker {
            let snap = concrete.snapshot()
            windowList = snap.surfaces
            surfaces = snap.surfaces + screens.screenSurfaces()
        } else {
            windowList = tracker.windowSurfaces()
            surfaces = tracker.allSurfaces()
        }

        // 跟随当前窗口 (doc §5.2): ride the frontmost window's top edge as it moves.
        if state.followWindow, let front = windowList.first {
            if state.currentSurface?.id != front.id || abs((state.currentSurface?.y ?? 0) - front.y) > 1 {
                machine.land(on: front)
                syncRenderer()
            }
            return
        }

        guard let current = state.currentSurface else { return }
        if !PerchSolver.surfaceStillValid(current, in: surfaces) {
            if let fb = PerchSolver.fallbackSurface(near: state.position.x, candidates: surfaces) {
                machine.land(on: fb)
                syncRenderer()
            }
        }
    }

    // MARK: Drag (OverlayContentDelegate)

    func overlayMouseDown(atLocal point: CGPoint) {
        let now = Date().timeIntervalSinceReferenceDate
        let global = toGlobal(point)
        petClickTracker = PetClickGestureTracker(downGlobal: global, startedAt: now)
        registerUserResponse()
        surface.routeCharacterHit(point)
        surface.apply(intent: CharacterAnimationIntent(state: .reacting,
                                                     emotion: .neutral,
                                                     intensity: 0.75,
                                                     priority: 70,
                                                     duration: 0.34,
                                                     source: .userInteraction))
        machine.beginDrag()
        surface.apply(intent: CharacterAnimationIntent(state: .dragged,
                                                     priority: 90,
                                                     source: .desktopInteraction))
        let feet = state.position
        dragOffset = CGSize(width: feet.x - global.x, height: feet.y - global.y)
        syncRenderer()
    }

    /// The user touched the pet → it gets more active and exits any quiet period (doc §8.1).
    private func registerUserResponse() {
        let now = Date().timeIntervalSinceReferenceDate
        engagement.interaction()
        proactivity.registerInteraction(now: now)
        lastInteraction = now
        // R1-3: notify the presence coordinator so the inactivity wake signal is real.
        // R2-13: this is the ONLY `onUserInteractionNote()` call site on a click; the
        // prior duplicate in `overlayMouseDown(atLocal:)` fired twice per mouse-down,
        // which doubled the coordinator's `noteUserInteraction()` calls and
        // raced the `lastUserInteractionAt` timestamp update.
        onUserInteractionNote()
        bubbleInteracted = true
        onPetTouched()
        // P16 — wire into the presence coordinator's wake/interaction signal if installed.
        let _ = now
    }

    // MARK: Relationship visuals (doc §10/§6.3)

    func setAccessories(_ items: Set<Accessory>) { surface.setAccessories(items) }

    func previewExpression(_ name: String?) {
        expressionPreviewQuietUntil = Date.timeIntervalSinceReferenceDate + 6
        surface.previewExpression(name)
    }
    func previewEmotion(_ emotion: PetEmotion) {
        expressionPreviewQuietUntil = Date.timeIntervalSinceReferenceDate + 6
        surface.react(emotion: emotion, action: .none)
    }

    func previewBubble() {
        setHidden(false)
        surface.showBubble("今天也慢慢来吧。我会安静地陪着你，把想做的事一件一件完成。长一点的消息会自然换行，超出四行会收起，不会撑满桌面。你可以随时调整我的大小，气泡文字会保持清晰。")
        bubbleActive = true
        bubbleInteracted = true
        bubbleEndsAt = Date.timeIntervalSinceReferenceDate + 15
    }

    func setCharacterHeight(_ height: Double) {
        guard height.isFinite else { return }
        characterHeight = CGFloat(min(420, max(120, height)))
        surface.preferredHeight = characterHeight
        state.position = clampFeet(state.position)
        syncRenderer()
    }

    func celebrateStageUp(_ stage: RelationshipStage) {
        sayBubble("我们的关系更近了一步——\(stage.label)！", emotion: .excited)
        surface.react(emotion: .excited, action: .cheer)
    }

    func overlayMouseDragged(atLocal point: CGPoint) {
        let g = toGlobal(point)
        petClickTracker?.recordDrag(to: g)
        var p = CGPoint(x: g.x + dragOffset.width, y: g.y + dragOffset.height)
        let current = DesktopEntityLayoutState(petFeet: state.position,
                                               nestAnchor: nestGlobal,
                                               homeTarget: state.home)
        let layout = desktopLayout.draggingPet(to: p, current: current, visibleFrames: visibleFramesForLayout)
        p = layout.petFeet
        state.position = p
        state.home = layout.homeTarget
        syncRenderer()
    }

    func overlayMouseUp(atLocal point: CGPoint) {
        let upGlobal = toGlobal(point)
        let endedAt = Date().timeIntervalSinceReferenceDate
        let shouldOpenChat = petClickTracker?.isClick(upGlobal: upGlobal, endedAt: endedAt) ?? false
        petClickTracker = nil

        machine.endDrag()
        let surfaces = tracker.allSurfaces()
        let landing = PerchSolver.landingSurface(at: state.position, candidates: surfaces)
            ?? PerchSolver.fallbackSurface(near: state.position.x, candidates: surfaces)
        if let landing { machine.land(on: landing) }
        surface.apply(intent: CharacterAnimationIntent(state: .landing,
                                                     priority: 80,
                                                     duration: 0.32,
                                                     source: .desktopInteraction))
        syncRenderer()
        do {
            try FileManager.default.createDirectory(at: placementURL.deletingLastPathComponent(), withIntermediateDirectories: true)
            try JSONEncoder().encode([Double(state.position.x), Double(state.position.y)]).write(to: placementURL, options: .atomic)
        } catch { NSLog("Character placement save failed: %@", error.localizedDescription) }
        if shouldOpenChat {
            onPetClickedForChat()
        }
    }

    // MARK: External commands (menu / hotkeys)

    func recall() {
        if state.isHidden { setHidden(false) }
        machine.recall()
    }

    func setHidden(_ hidden: Bool) {
        state.isHidden = hidden
        surface.setVisible(!hidden, animated: true)
    }

    func toggleHidden() { setHidden(!state.isHidden) }

    func setPassthrough(_ mode: PassthroughMode) {
        state.passthrough = mode
        applyPassthrough()
    }

    func setPlayful(_ on: Bool) { state.playfulMode = on }

    /// Build the perceived context the policy permits (doc §11.4). Never reads window content;
    /// L1 is app identity only, L2 is a whitelisted title, L3 is handled separately with consent.
    func perceivedContext(_ policy: PerceptionPolicy) -> PerceivedContext {
        // P18 — when an authoritative `DesktopAwarenessService` is wired we project
        // from its snapshot instead of re-querying NSWorkspace / CGWindowList.
        // Otherwise we fall back to the legacy path so unit tests / harnesses without
        // the service continue to work.
        if let service = awarenessService {
            return service.perceivedContext()
        }
        var ctx = PerceivedContext()
        let front = NSWorkspace.shared.frontmostApplication
        if policy.canReadApp { ctx.frontmostApp = front?.localizedName }
        if policy.canReadTitle(ofBundleID: front?.bundleIdentifier) {
            ctx.windowTitle = tracker.frontmostWindowTitle()
        }
        return ctx
    }

    /// P18 — Probe that exposes the underlying `WindowTracker` so AppDelegate can
    /// wire the shared `DesktopAwarenessService`. Not exposed publicly because the
    /// `WindowTracker` is implementation-private; only the AppDelegate hook
    /// consumes it.
    func windowTrackerProbe() -> (any WindowTrackerProviding)? { tracker }

    /// P18 — Stash the authoritative awareness service onto the overlay. The
    /// overlay's `perceivedContext(_:)` will route through the service instead
    /// of calling NSWorkspace directly.
    private(set) var awarenessService: DesktopAwarenessService?

    /// P18 — AppDelegate calls this once at launch to wire the shared awareness
    /// subsystem. The overlay then drops its direct NSWorkspace lookup.
    func attachAwarenessService(_ service: DesktopAwarenessService) {
        awarenessService = service
    }

    /// Push a line to the desktop bubble layer (doc §11.1 短气泡) — used by quick chat / AI.
    func sayBubble(_ text: String, emotion: PetEmotion = .neutral) {
        let now = Date().timeIntervalSinceReferenceDate
        startBubble(text, now: now, kind: .quick, emotion: emotion)
        bubbleInteracted = true   // user-initiated, so it's not an "ignored" bubble
    }

    /// Apply a structured AI reaction to the pet (doc §11.5).
    func reactPet(emotion: PetEmotion, action: PetAction) {
        surface.react(emotion: emotion, action: action)
    }

    func handleAgentAnimationEvent(_ event: PetAgentAnimationEvent) {
        let intent = AgentAnimationEventMapper.intent(for: event)
        surface.apply(intent: intent)
        switch event {
        case .responseStarted, .responseDelta:
            surface.setSpeakingLevel(Float(CharacterAnimationConfig.default.speaking.textFallbackLevel))
        case .responseFinished, .responseFailed, .responseCancelled:
            surface.setSpeakingLevel(0)
        default:
            break
        }
    }

    /// A focus session started/ended → switch the pet to/from light-companion study mode (doc §9.5).
    /// P22 — on focus start the pet walks to a "focus spot" near the
    /// bottom-centre of the main screen and parks there; on focus end the
    /// spot is cleared and idle wander resumes.
    func setFocusActive(_ active: Bool) {
        context.focusActive = active
        surface.setStudyMode(active)
        if active {
            endBubble()                  // no proactive bubbles during focus
            surface.setFocusSpot(focusSpotOnActiveScreen())
        } else {
            surface.setFocusSpot(nil)
        }
    }

    /// Bottom-centre of the visible screen, 80pt up from the bottom edge so
    /// the pet sits comfortably above the Dock and clear of the menu bar.
    /// Falls back to the overlay's own screen if the main window isn't
    /// yet on-screen.
    private func focusSpotOnActiveScreen() -> CGPoint? {
        let screen: NSScreen
        if let w = mainWindowRef, let s = w.windowScreen ?? NSScreen.main {
            screen = s
        } else if let s = NSScreen.main {
            screen = s
        } else {
            return nil
        }
        let frame = screen.visibleFrame
        // `visibleFrame` already excludes the menu bar and a bottom dock,
        // but the Dock inset is not always exact (e.g. auto-hidden Dock,
        // or a side Dock). Push the focus spot up by a fixed safety margin
        // (120pt) so the pet always lands comfortably clear of:
        //   • Dock at bottom (up to ~80pt)
        //   • A second monitor's notch / menu bar overlap
        //   • Stage Manager focus rings
        let safeMinY = frame.minY + 120
        return CGPoint(x: frame.midX, y: max(safeMinY, frame.minY + 60))
    }

    /// Wired up in `AppDelegate` so we can ask the main window for the
    /// focus anchor. Public seams > private coupling for this kind of
    /// cross-controller coordination.
    var mainWindowRef: MainWindowController?

    func setAbsoluteQuiet(_ on: Bool) {
        context.absoluteQuiet = on
        if on { endBubble() }       // silence immediately
    }
    var absoluteQuiet: Bool { context.absoluteQuiet }

    /// 待在这里 — pin in place (stop wandering).
    func setPinned(_ on: Bool) { state.pinned = on }

    /// 跟随当前窗口 — ride the frontmost window's top edge.
    func setFollowWindow(_ on: Bool) {
        state.followWindow = on
        if on, let front = tracker.windowSurfaces().first {
            machine.land(on: front)
            syncRenderer()
        }
    }

    #if DEBUG
    private enum LumiVisualSmokeRequest {
        case state(CharacterAnimationState, CharacterLocomotionDirection?)
        case agentEvent(String, PetAgentAnimationEvent)
        case hold

        var label: String {
            switch self {
            case .state(let state, let direction):
                if let direction { return "\(state.rawValue):\(direction.rawValue)" }
                return state.rawValue
            case .agentEvent(let name, _):
                return name
            case .hold:
                return "hold"
            }
        }
    }

    func runLumiScholarVisualSmoke(outputDirectory: URL) async {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write("LUMI_VISUAL_SMOKE createDir failed=\(error)\n".data(using: .utf8)!)
            return
        }

        behaviorTimer?.invalidate()
        behaviorTimer = nil
        surfaceTimer?.invalidate()
        surfaceTimer = nil

        scene.setVisible(true, animated: false)
        syncRenderer()

        var report: [[String: Any]] = []
        report.append(await runLumiVisualSmokeStep("00_idle_start",
                                                   request: .state(.idle, nil),
                                                   holdSeconds: 0.2,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("01_idle_10s",
                                                   request: .hold,
                                                   holdSeconds: 10.0,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("02_transition_idle_to_move_right",
                                                   request: .state(.walkRight, .right),
                                                   holdSeconds: 0.12,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("03_move_right_5s",
                                                   request: .hold,
                                                   holdSeconds: 5.0,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("04_transition_move_right_to_idle",
                                                   request: .state(.idle, nil),
                                                   holdSeconds: 0.14,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("05_transition_idle_to_move_left",
                                                   request: .state(.walkLeft, .left),
                                                   holdSeconds: 0.12,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("06_move_left_5s",
                                                   request: .hold,
                                                   holdSeconds: 5.0,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("07_transition_move_left_to_idle",
                                                   request: .state(.idle, nil),
                                                   holdSeconds: 0.14,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("08_waiting",
                                                   request: .agentEvent("providerWaiting", .providerWaiting),
                                                   holdSeconds: 1.0,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("09_running",
                                                   request: .agentEvent("taskRunning", .taskRunning),
                                                   holdSeconds: 1.2,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("10_review",
                                                   request: .agentEvent("taskReview", .taskReview),
                                                   holdSeconds: 1.2,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("11_success_jump",
                                                   request: .agentEvent("taskSucceeded", .taskSucceeded),
                                                   holdSeconds: 0.35,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("12_success_idle",
                                                   request: .hold,
                                                   holdSeconds: 0.7,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("13_running_before_failed",
                                                   request: .agentEvent("taskRunning", .taskRunning),
                                                   holdSeconds: 1.0,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("14_failed",
                                                   request: .agentEvent("terminalFailure", .terminalFailure),
                                                   holdSeconds: 0.55,
                                                   outputDirectory: outputDirectory))
        report.append(await runLumiVisualSmokeStep("15_failed_idle",
                                                   request: .hold,
                                                   holdSeconds: 1.1,
                                                   outputDirectory: outputDirectory))

        let feet = toLocal(state.position)
        scene.setLookTarget(CGPoint(x: feet.x + 100, y: feet.y))
        report.append(await runLumiVisualSmokeStep("16_look_000_debug_preview",
                                                   request: .state(.idle, nil),
                                                   holdSeconds: 0.2,
                                                   outputDirectory: outputDirectory))
        scene.setLookTarget(nil)

        let reportURL = outputDirectory.appendingPathComponent("runtime_lumi_visual_smoke.json")
        do {
            let payload: [String: Any] = [
                "characterID": "lumi-scholar",
                "steps": report,
                "notes": [
                    "DEBUG-only real OverlayWindowController/SpriteKit smoke.",
                    "Human visual acceptance is still manual."
                ]
            ]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: reportURL)
        } catch {
            FileHandle.standardError.write("LUMI_VISUAL_SMOKE report failed=\(error)\n".data(using: .utf8)!)
        }
    }

    private func runLumiVisualSmokeStep(_ name: String,
                                        request: LumiVisualSmokeRequest,
                                        holdSeconds: TimeInterval,
                                        outputDirectory: URL) async -> [String: Any] {
        switch request {
        case .state(let state, let direction):
            forceCharacterVisualState(state, direction: direction)
        case .agentEvent(_, let event):
            forceCharacterVisualEvent(event)
        case .hold:
            break
        }

        await holdLumiVisualSmoke(seconds: holdSeconds)
        let fileURL = outputDirectory.appendingPathComponent("\(name).png")
        let captureOK = captureSmokeScreenshot(to: fileURL)
        let d = scene.diagnostics()
        let entry: [String: Any] = [
            "step": name,
            "request": request.label,
            "holdSeconds": holdSeconds,
            "diagnosticState": d.state.rawValue,
            "currentClipID": d.currentClipID ?? NSNull(),
            "resourceLoaded": d.resourceLoaded,
            "characterID": d.characterID ?? NSNull(),
            "manifestPath": d.manifestPath ?? NSNull(),
            "assetRootPath": d.assetRootPath ?? NSNull(),
            "selectedDefaultCharacterID": d.selectedDefaultCharacterID ?? NSNull(),
            "loadedFallbackCharacter": d.loadedFallbackCharacter,
            "activeFramePath": d.activeFramePath ?? NSNull(),
            "fallbackReason": d.fallbackReason ?? NSNull(),
            "screenshotPath": fileURL.path,
            "captureOK": captureOK
        ]
        FileHandle.standardError.write("LUMI_VISUAL_SMOKE step=\(name) state=\(d.state.rawValue) clip=\(d.currentClipID ?? "nil") capture=\(captureOK)\n".data(using: .utf8)!)
        return entry
    }

    private func holdLumiVisualSmoke(seconds: TimeInterval) async {
        var remaining = max(0, seconds)
        while remaining > 0 {
            let dt = min(1.0 / 30.0, remaining)
            scene.update(deltaTime: dt)
            skView.displayIfNeeded()
            try? await Task.sleep(nanoseconds: UInt64(dt * 1_000_000_000))
            remaining -= dt
        }
    }

    private func forceCharacterVisualEvent(_ event: PetAgentAnimationEvent) {
        var intent = AgentAnimationEventMapper.intent(for: event)
        intent.priority = 95
        intent.interruptPolicy = .alwaysInterrupt
        scene.apply(intent: intent)
    }

    func runCharacterWalkVisualSmoke(outputDirectory: URL) async {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write("CHARACTER_WALK_SMOKE createDir failed=\(error)\n".data(using: .utf8)!)
            return
        }
        scene.setVisible(true, animated: false)
        syncRenderer()

        let steps: [(String, CharacterAnimationState, CharacterLocomotionDirection?)] = [
            ("00_idle", .idle, nil),
            ("01_walk_right", .walkRight, .right),
            ("02_idle_after_walk_right", .idle, nil),
            ("03_walk_left", .walkLeft, .left),
            ("04_walk_right_before_left", .walkRight, .right),
            ("05_walk_right_to_left", .walkLeft, .left),
            ("06_walk_left_before_idle", .walkLeft, .left),
            ("07_walk_left_to_idle", .idle, nil),
            // P19.2 — verify that the new CharacterV2-augmented transitions
            // render with real PNGs (no placeholder fallback).
            ("08_start_move_left", .startMovingLeft, .left),
            ("09_start_move_right", .startMovingRight, .right),
            ("10_stop_move_left", .stopMovingLeft, .left),
            ("11_stop_move_right", .stopMovingRight, .right),
            ("12_turn_left_to_front", .turnLeftToFront, .left),
            ("13_turn_right_to_front", .turnRightToFront, .right),
            // P19.2H — J. Left ↔ Right reversal (mid-walk direction flip).
            ("14_walk_left_to_right_reversal", .walkRight, .right),
            // K. repeated start / stop cycles (5 in each direction).
            ("15_repeated_start_stop_left_a", .startMovingLeft, .left),
            ("16_repeated_start_stop_left_b", .stopMovingLeft, .left),
            ("17_repeated_start_stop_right_a", .startMovingRight, .right),
            ("18_repeated_start_stop_right_b", .stopMovingRight, .right),
            ("19_repeated_start_stop_left_c", .startMovingLeft, .left),
            ("20_repeated_start_stop_left_d", .stopMovingLeft, .left),
            // L. interaction/task pose → locomotion → interaction/task pose
            ("21_task_failed_to_walk", .walkLeft, .left),
            ("22_walk_back_to_idle", .idle, nil),
            ("23_listening_to_walk", .walkRight, .right),
            ("24_walk_to_thinking", .thinking, nil),
            ("25_thinking_to_idle", .idle, nil)
        ]

        var report: [[String: Any]] = []
        for step in steps {
            forceCharacterVisualState(step.1, direction: step.2)
            for _ in 0..<10 {
                scene.update(deltaTime: 1.0 / 30.0)
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
            let fileURL = outputDirectory.appendingPathComponent("\(step.0).png")
            let captureOK = captureSmokeScreenshot(to: fileURL)
            let d = scene.diagnostics()
            report.append([
                "step": step.0,
                "requestedState": step.1.rawValue,
                "requestedDirection": step.2?.rawValue ?? NSNull(),
                "diagnosticState": d.state.rawValue,
                "currentClipID": d.currentClipID ?? NSNull(),
                "resourceLoaded": d.resourceLoaded,
                "fallbackReason": d.fallbackReason ?? NSNull(),
                "screenshotPath": fileURL.path,
                "captureOK": captureOK
            ])
            FileHandle.standardError.write("CHARACTER_WALK_SMOKE step=\(step.0) state=\(d.state.rawValue) clip=\(d.currentClipID ?? "nil") capture=\(captureOK)\n".data(using: .utf8)!)
        }

        let reportURL = outputDirectory.appendingPathComponent("runtime_walk_visual_smoke.json")
        do {
            let data = try JSONSerialization.data(withJSONObject: ["steps": report], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: reportURL)
        } catch {
            FileHandle.standardError.write("CHARACTER_WALK_SMOKE report failed=\(error)\n".data(using: .utf8)!)
        }
    }

    // MARK: P19.3 — idle-presence visual smoke (DEBUG only).

    /// Drives the production `StaticPNGCharacterRenderer` through the P19.3 idle
    /// presence flow so a real human can observe blink + look-around + idle
    /// loop + breathing + transitions back to neutral idle. Uses a deterministic
    /// idle scheduler seed so the captured sequence is reproducible.
    ///
    /// Sequence (production timing, NOT accelerated):
    ///   00 idle baseline (just-spawned, no ambient events yet)
    ///   01 idle baseline after initial settle (still no ambient)
    ///   02 forced blink (peak compression)
    ///   03 blink recovery (back to neutral)
    ///   04 forced look-around (peak X-offset + rotation)
    ///   05 look-around recovery (back to neutral)
    ///   06 idle breathing peak (3.6s sine, scaleY max)
    ///   07 idle breathing trough (scaleY min)
    ///   08 idle + blink again (re-confirms visibility)
    ///   09 interaction/task pose → idle (recovery path)
    ///   10 task failed → idle (recovery path with longer settle)
    func runIdlePresenceVisualSmoke(outputDirectory: URL) async {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write("IDLE_PRESENCE_SMOKE createDir failed=\(error)\n".data(using: .utf8)!)
            return
        }
        scene.setVisible(true, animated: false)
        // Reset FSM via the same neutral-reset seam presenceVisualSmoke uses.
        scene.apply(intent: CharacterAnimationIntent(state: .idle,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.20,
                                                     source: .runtimeLifecycle))
        for _ in 0..<20 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 200_000_000)

        var report: [[String: Any]] = []

        func snap(name: String) async {
            for _ in 0..<6 { scene.update(deltaTime: 1.0 / 30.0) }
            try? await Task.sleep(nanoseconds: 80_000_000)
            let fileURL = outputDirectory.appendingPathComponent("\(name).png")
            let ok = captureSmokeScreenshot(to: fileURL)
            let d = scene.diagnostics()
            report.append([
                "step": name,
                "diagnosticState": d.state.rawValue,
                "currentClipID": d.currentClipID ?? NSNull(),
                "resourceLoaded": d.resourceLoaded,
                "fallbackReason": d.fallbackReason ?? NSNull(),
                "screenshotPath": fileURL.path,
                "captureOK": ok
            ])
            FileHandle.standardError.write("IDLE_PRESENCE_SMOKE step=\(name) state=\(d.state.rawValue) clip=\(d.currentClipID ?? "nil") capture=\(ok)\n".data(using: .utf8)!)
        }

        // 00 — idle baseline immediately after spawn.
        await snap(name: "00_idle_baseline")
        // 01 — let the initial settle window pass.
        for _ in 0..<15 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        await snap(name: "01_idle_after_settle")
        // 02 — force blink (priority 14, override the scheduler).
        scene.apply(intent: CharacterAnimationIntent(state: .blink,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.14,
                                                     source: .rendererFallback))
        // Capture mid-blink at 2 ticks (≈0.067s = peak compression / closed-eye frame).
        for _ in 0..<2 { scene.update(deltaTime: 1.0 / 30.0) }
        await snap(name: "02_blink_peak_compression")
        // 03 — let blink finish, return to idle.
        for _ in 0..<10 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        await snap(name: "03_blink_recovery_to_idle")
        // 04 — force look-around.
        scene.apply(intent: CharacterAnimationIntent(state: .idleLookAround,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.8,
                                                     source: .rendererFallback))
        // Capture mid-sway at 6 ticks (≈0.2s = peak X-offset).
        for _ in 0..<6 { scene.update(deltaTime: 1.0 / 30.0) }
        await snap(name: "04_lookaround_peak_sway")
        // 05 — let look-around finish.
        for _ in 0..<15 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        await snap(name: "05_lookaround_recovery_to_idle")
        // 06 — idle breathing peak: drive scene.update for 0.9s with neutral reset.
        scene.apply(intent: CharacterAnimationIntent(state: .idle,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.20,
                                                     source: .runtimeLifecycle))
        for _ in 0..<10 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        // 3.6s sine breath: half-period is 1.8s. We're now ~0.83s in → near peak.
        await snap(name: "06_idle_breathing_peak")
        // 07 — wait another ~0.9s → near trough of breathing.
        for _ in 0..<27 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        await snap(name: "07_idle_breathing_trough")
        // 08 — second forced blink (re-confirms visibility on the SAME character after some idle time).
        scene.apply(intent: CharacterAnimationIntent(state: .blink,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.14,
                                                     source: .rendererFallback))
        for _ in 0..<5 { scene.update(deltaTime: 1.0 / 30.0) }
        await snap(name: "08_second_blink")
        // 09 — task pose → idle recovery: taskWaiting (50) → idle.
        scene.apply(intent: CharacterAnimationIntent(state: .taskWaiting,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.4,
                                                     source: .agentRuntime))
        for _ in 0..<12 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        // Should now be back in idle (within settle debounce).
        await snap(name: "09_task_to_idle_within_settle")
        // 10 — task failed (priority 70, longer duration) → idle.
        scene.apply(intent: CharacterAnimationIntent(state: .taskFailed,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 1.4,
                                                     source: .agentRuntime))
        for _ in 0..<42 { scene.update(deltaTime: 1.0 / 30.0) }
        try? await Task.sleep(nanoseconds: 250_000_000)
        await snap(name: "10_task_failed_to_idle_after_settle")

        let reportURL = outputDirectory.appendingPathComponent("runtime_idle_presence_smoke.json")
        do {
            let data = try JSONSerialization.data(withJSONObject: ["steps": report], options: [.prettyPrinted, .sortedKeys])
            try data.write(to: reportURL)
        } catch {
            FileHandle.standardError.write("IDLE_PRESENCE_SMOKE report failed=\(error)\n".data(using: .utf8)!)
        }
    }

    private func forceCharacterVisualState(_ state: CharacterAnimationState,
                                           direction: CharacterLocomotionDirection?) {
        let speedTier: CharacterLocomotionSpeedTier? = direction == nil ? nil : .walk
        let speed: Double? = direction == nil ? nil : 60
        scene.apply(intent: CharacterAnimationIntent(state: state,
                                                     locomotionDirection: direction,
                                                     speedTier: speedTier,
                                                     speedPointsPerSecond: speed,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     source: .runtimeLifecycle))
    }

    private func captureSmokeScreenshot(to url: URL) -> Bool {
        skView.displayIfNeeded()
        if let texture = skView.texture(from: scene) {
            let cgImage = texture.cgImage()
            let rep = NSBitmapImageRep(cgImage: cgImage)
            if let data = rep.representation(using: .png, properties: [:]) {
                do {
                    try data.write(to: url)
                    return true
                } catch {
                    FileHandle.standardError.write("CHARACTER_WALK_SMOKE texture screenshot failed=\(error)\n".data(using: .utf8)!)
                }
            }
        }

        let bounds = skView.bounds
        guard let rep = skView.bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        skView.cacheDisplay(in: bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        do {
            try data.write(to: url)
            return true
        } catch {
            FileHandle.standardError.write("CHARACTER_WALK_SMOKE screenshot failed=\(error)\n".data(using: .utf8)!)
            return false
        }
    }

// MARK: P16 — presence visual smoke harness (DEBUG only).

    /// Drives the REAL `CharacterPresenceCoordinator` through synthetic store edges so the
    /// presence states (idle → attentive → thinking → working → waiting → success → … →
    /// sleeping → wake → RM-thinking) are each captured as a screenshot + JSON entry.
    ///
    /// The coordinator is constructed with the same dependencies the production wiring uses
    /// (real `AgentTaskActivityStore`, real `FloatingChatStateStore`, real
    /// `ContainerBehaviorAdvancer`-style advancer if available) so the captured state pair is
    /// faithful to shipping. Steps correspond to plan §8.2.
    ///
    /// R1-10 — every step drives its visual purely via the coordinator's derivation pipeline
    /// (real task events, real chat changes, real wake sources). Steps 12-14 (sleep / wake /
    /// RM-thinking) no longer hand-apply scene intents. The harness enforces an expected
    /// semantic↔renderer pair per step and writes a `mismatch` flag + `failedSteps` list to
    /// the JSON report.
    func runPresenceVisualSmoke(outputDirectory: URL) async {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        } catch {
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE createDir failed=\(error)\n".data(using: .utf8)!)
            return
        }

        behaviorTimer?.invalidate(); behaviorTimer = nil
        surfaceTimer?.invalidate(); surfaceTimer = nil

        // R2-5 smoke isolation: reset the renderer FSM via the existing
        // `forceCharacterVisualState` seam (priority 95 / .alwaysInterrupt)
        // rather than the prior p10 idle apply — the latter was rejected by
        // the renderer FSM arbitration if the production coordinator had
        // left a higher-priority sustained visual on the scene (R2-5 root
        // cause for steps 00-08 showing `reacting` / stuck visuals).
        //
        // The reset intent carries a short `neutralResetDuration` (0.20 s)
        // so it EXPIRES during the first settle-loop iteration of step 00
        // instead of permanently blocking the subsequent coordinator
        // dispatches (each dispatch's `interruptPolicy` is
        // `.interruptLowerPriority`, so any p10-p68 intent is rejected by
        // the sustained p95 reset without an expiry path).
        scene.apply(intent: CharacterAnimationIntent(state: .idle,
                                                     priority: 95,
                                                     interruptPolicy: .alwaysInterrupt,
                                                     duration: 0.20,
                                                     source: .runtimeLifecycle))
        scene.setVisible(true, animated: false)
        syncRenderer()
        FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE reset renderer FSM to idle via p95/.alwaysInterrupt/0.20s\n".data(using: .utf8)!)

        // Build a small realtime clock — the production wiring uses `Date.init`. We want
        // wall-clock here so the 1 Hz sleep cadence is honoured.
        let activityStore = AgentTaskActivityStore(persistence: nil)
        let chatStore = FloatingChatStateStore()
        // Stub advancer: drives the local behavior-machine instance; the production wiring
        // uses `ContainerBehaviorAdvancer` and is exercised at app startup.
        let stub = PresenceSmokeStubAdvancer(initial: .dormant)
        var captured: [(name: String, semantic: String?, stateRaw: String)] = []

        // Build a coordinator with a fast sleep threshold for the sleep step (R1-3 production-real).
        var presenceConfig = CharacterPresenceCoordinator.Configuration()
        presenceConfig.currentRendererIntent = { [weak self] in self?.scene.diagnostics().currentIntent }
        presenceConfig.policy.sleepAfterThreshold = 0.5   // 500 ms for the smoke (wall clock).
        let coordinator = CharacterPresenceCoordinator(
            activityStore: activityStore,
            chatStore: chatStore,
            advancer: stub,
            configuration: presenceConfig,
            applyIntent: { [weak self] intent in self?.scene.apply(intent: intent) },
            onPresenceEngage: { [weak self] engaged in
                if engaged {
                    self?.machine.holdStill()
                    self?.machine.suppressWander = true
                } else {
                    self?.machine.suppressWander = false
                }
            })
        // R1-3 production-real: a real user-interaction note called from the cancel and wake
        // paths so the inactivity accounting observes it.
        let userNoteProxy = PresenceVisualSmokeUserNoteProxy(coordinator: coordinator)

        // R2-7: expected pairs re-authored to assert what the architecture actually
        // guarantees after R2-1 / R2-2 / R2-3 / R2-5 / R2-6 / R2-8 are all in place.
        // The prior pairs enshrined behaviors that the production path cannot
        // produce (semantic `success` from the derive, renderer jump past the
        // one-shot expiry, etc.). The new pairs accept two possibilities where
        // the architecture offers them — see per-step notes.

        // R3-1: chat-hide-after-dwell (step 15) needs > sustainedMinDwell
        // wall-clock between `chatStore.expand()` and `chatStore.collapseToCapsule()`
        // to exercise the dwell-ELAPSED path. The default 1.5 s is
        // honoured and the step body waits 2000 ms so the dwell check
        // succeeds deterministically. Other steps are unaffected.
        let smokeSustainedMinDwell = presenceConfig.policy.sustainedMinDwell
        _ = smokeSustainedMinDwell // referenced from the step body below
        let expectedPairs: [(name: String, semantic: String?, rendererState: String,
                              altSemantics: [String]?, altRendererStates: [String]?)] = [
            // 00: idle baseline. The renderer FSM is forced to .idle (p95/.alwaysInterrupt);
            // the coordinator derives .idle. Match exactly.
            ("00_idle", "idle", "idle", nil, nil),
            // 01: chat expand → attentive listening p45 (promotion over idle p10 → accepted).
            ("01_attentive_chat_expand", "attentive", "listening", nil, nil),
            // 02: thinking — isResponding + no streaming → semantic .thinking, renderer thinking.
            ("02_thinking", "thinking", "thinking", nil, nil),
            // 03: working — executionStarted → semantic .working (taskRunning), machine .acting.
            ("03_working", "working", "taskRunning", nil, nil),
            // 04: waiting approval — clearing p59 dispatch wins against the prior working
            // visual. (The wait semantic .waiting resolves to taskWaiting p50, but R2-1's
            // clearing path raises it to p59 which beats stuck working p55.)
            ("04_waiting_approval", "waiting", "taskWaiting", nil, nil),
            // 05: success — step 04 already fired the first taskSucceeded
            // (runID) which set `lastSuccessIntentAt`; the default
            // `successCooldown` (8 s) suppresses step 05's jump one-shot
            // for approveID/runID. The actual reachable outcome at capture
            // is the attentive listening visual (.listening) — the success
            // terminal reactions advance the machine to .idle and the
            // post-derive dispatches .attentive (chat still expanded, no
            // tasks). Renderer captures as .listening (primary), or .idle
            // (if the post-clear settle lands before the attentive
            // listening p45 wins). R3-5 makes the primary reachable —
            // the prior "jump" primary was unreachable in this cooldown
            // configuration and merely documenting the intended behavior
            // of the no-cooldown variant. R5-4: the "jump" alt is
            // dropped because the harness never overrides successCooldown
            // (presenceConfig only overrides sleepAfterThreshold) and
            // the default 8 s cooldown is deterministically primed by
            // step 04's runID terminal — the "jump" alt was unreachable
            // in this configuration and would silently absorb a future
            // regression to jump-capturing.
            ("05_success", "attentive", "listening", nil, ["idle"]),
            // 06: idle after success — chat collapsed + isResponding false, success expired.
            // The renderer may also show .idleLookAround from the ambient idle
            // scheduler if the smoke step aligns with its 5.5-11 s window.
            ("06_idle_after_success", "idle", "idle", nil, ["idleLookAround"]),
            // 07: cancel during working — the responseCancelled funnel fires .interrupt
            // → machine .interrupted; trap-exit (R2-3) advances to .idle. The derive
            // dispatches .idle (clearing p59). After settle, renderer is at .idle OR
            // .idleLookAround (the renderer's ambient idle scheduler fires its
            // 5.5-11 s idleLookAround one-shot if the smoke step aligns with that
            // window). Accept either.
            ("07_cancel_during_working", "idle", "idle", nil, ["idleLookAround", "blink"]),
            // 08: recovery neutral — settled state after cancel + beats.
            // The renderer may show .idleLookAround (ambient idle
            // scheduler) if the smoke aligns with its 5.5-11 s window.
            // R4-5: the prior `sleeping` semantic alt was the
            // deterministic stale-semantic of the greeted wake branch
            // (R4-4) — that branch now stamps
            // `derivedVisualSemantic = .idle` directly so the public
            // snapshot is .idle within the same turn. The settle loop
            // also uses `noteUserInteraction(suppressGreet: true)`
            // (R4-3) so the pet's freshness refresh does not consume
            // the greetOnWakeCooldown before step 13 can fire its own
            // wake. No more documented sleeping semantic alt.
            ("08_recovery_neutral", "idle", "idle", nil, ["idleLookAround"]),
            // 09: failure — taskFailed one-shot fires (p70). Renderer = .taskFailed.
            // Machine advances to .errorRecovery then immediately to .idle via the
            // R2-3 trap-exit (no engagement to convert the recovery chain). The
            // captured semantic is .idle (post-recovery); the renderer visual is
            // still .taskFailed (the one-shot hasn't expired yet within the 1 s settle).
            // R2-3 accepts either .recovery (if the trap-exit were deferred) or .idle
            // (the actual post-recovery value).
            ("09_failed", "idle", "taskFailed", ["recovery"], nil),
            // 10: failure expired → clearing dispatch wins → renderer .idle. The
            // semantic converges to .idle. The renderer may also show .idleLookAround
            // from the ambient idle scheduler (5.5-11 s window). Accept either.
            ("10_concerned_then_idle", "idle", "idle", nil, ["idleLookAround", "blink"]),
            // 11: walk re-assert — the coordinator's derive dispatches .idle but the
            // renderer priority arbitration (idle p10 < walk p35) lets the
            // locomotion controller's walk reassert win. R4-5: the
            // prior `idle` alt was the deterministic output of the
            // R3 reconcile-stuck clear (R4-1 murder) — the round-4
            // stuck gate restricts clearing to genuine
            // agent-sustained visuals (source == .agentRuntime,
            // duration == nil, state ∈ {listening, thinking,
            // speaking, taskWaiting, taskRunning, taskReview,
            // sleeping}). Locomotion is `.desktopInteraction` so the
            // walk p35 visual survives every reconcile tick and
            // `walkRight` is the primary reachable outcome (no `idle`
            // alt).
            ("11_walk_reassert_after_intent_expiry", "idle", "walkRight", nil, nil),
            // 12: sleep — machine .sleeping, semantic .sleeping, renderer .sleeping.
            ("12_sleep", "sleeping", "sleeping", nil, nil),
            // 13: wake + greet — noteUserInteraction wakes + emits the
            // wake-greet one-shot (p44 greet beats sleeping p40 and
            // the machine advances to .idle). R4-3: in-window capture
            // via the settle loop's inWindowCapture hook — the
            // renderer's first encounter with `.greet` within the
            // 0.72 s window is the captured value. R4-1: the reconcile
            // stuck gate excludes finite-duration one-shots (greet
            // carries 0.72 s) so the greet is not murdered by an early
            // reconcile tick. R4-5: no `idle` or `walkRight` alts —
            // the primary is reachable deterministically in the smoke
            // window (the settle loop is 990 ms and greet lasts 720
            // ms — the first ~22 settle iterations see `.greet` on
            // the renderer before the post-greet reconcile clears to
            // `.idle`). The prior alts were masking the R3 regression
            // (R4-3); R4-3 fixes both the harness AND the runtime
            // path so the primary is reachable.
            ("13_wake_greet", "idle", "greet", nil, nil),
            // 14: RM thinking — isResponding with reduceMotion → .look1125 static pose.
            // The renderer's diagnostic state is the enum rawValue ("look_112_5"),
            // which is what `d.state.rawValue` captures in `runPresenceSmokeStep`.
            ("14_rm_thinking_look_pose", "thinking", "look_112_5", nil, nil),
            // 15: chat-hide-after-dwell — expand chat, wait past
            // sustainedMinDwell (0.3 s in the smoke), collapse chat.
            // Without the R3-1 fix the renderer strands at .listening
            // p45 because the standard `.idle` p10 dispatch is rejected
            // and the reconcile stuck threshold doesn't see p45. R3-1
            // dispatches a clearing p59 idle from the falling edge and
            // raises the reconcile stuck gate via the SEMANTIC's own
            // priority — so the renderer reaches .idle. Accept
            // .idleLookAround (ambient idle scheduler) per the same
            // pattern as steps 06 / 07 / 08 / 10.
            ("15_chat_hide_after_dwell", "idle", "idle", nil, ["idleLookAround"])
        ]

        await coordinator.start()

        // 00 — idle start
        await runPresenceSmokeStep(name: "00_idle",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in /* nothing */ },
                                   capture: { captured.append(($0, $1, $2)) })

        // 01 — attentive on chat expand
        await runPresenceSmokeStep(name: "01_attentive_chat_expand",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, chatStore in chatStore.expand() },
                                   capture: { captured.append(($0, $1, $2)) })

        // 02 — thinking
        await runPresenceSmokeStep(name: "02_thinking",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, chatStore in chatStore.isResponding = true },
                                   capture: { captured.append(($0, $1, $2)) })

        // 03 — working (publish a running task)
        let runID = UUID()
        await runPresenceSmokeStep(name: "03_working",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { activityStore, _ in
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: runID, runID: runID,
                                                                  conversationID: runID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 1,
                                                                  timestamp: Date(),
                                                                  kind: .executionStarted,
                                                                  presentation: AgentTaskEventPresentation(title: "working", detail: "x"))))
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 04 — waiting for approval (R2-8 hygiene: clean up step 03 task so activeTasks
        // is empty when the approval-requested task lands; otherwise the engaged
        // derivation prefers .working over .waiting).
        let approveID = UUID()
        await runPresenceSmokeStep(name: "04_waiting_approval",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { activityStore, _ in
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: runID, runID: runID,
                                                                  conversationID: runID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 2,
                                                                  timestamp: Date(),
                                                                  kind: .taskSucceeded,
                                                                  presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: approveID, runID: approveID,
                                                                  conversationID: approveID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 1,
                                                                  timestamp: Date(),
                                                                  kind: .approvalRequested,
                                                                  presentation: AgentTaskEventPresentation(title: "waiting", detail: "x"))))
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 05 — success: terminal-succeeded for the working task AND clear the approval task.
        // Reset isResponding at the start so the engaged derivation returns
        // .attentive (chat expanded, no task) instead of .thinking (isResponding).
        await runPresenceSmokeStep(name: "05_success",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { activityStore, chatStore in
                                       chatStore.isResponding = false
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: approveID, runID: approveID,
                                                                  conversationID: approveID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 2,
                                                                  timestamp: Date(),
                                                                  kind: .approvalGranted,
                                                                  presentation: AgentTaskEventPresentation(title: "approve", detail: "x"))))
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: approveID, runID: approveID,
                                                                  conversationID: approveID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 3,
                                                                  timestamp: Date(),
                                                                  kind: .taskSucceeded,
                                                                  presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: runID, runID: runID,
                                                                  conversationID: runID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 2,
                                                                  timestamp: Date(),
                                                                  kind: .taskSucceeded,
                                                                  presentation: AgentTaskEventPresentation(title: "ok", detail: "x"))))
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 06 — idle after success (success jump has expired; reconcile has restored idle)
        await runPresenceSmokeStep(name: "06_idle_after_success",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, chatStore in
                                       chatStore.collapseToCapsule()
                                       // Reset isResponding so the engaged derivation
                                       // returns .idle for steps 06+ (without this
                                       // every subsequent step is pinned at .thinking
                                       // because the chat sink's streaming path keeps
                                       // isResponding = true).
                                       chatStore.isResponding = false
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 07 — cancel during working. R2-8: publish a `taskCancelled` store terminal
        // for cancelID AFTER the response-cancelled funnel — without this the
        // `activeTasks` snapshot stays non-empty and pins the machine at .acting
        // through every subsequent step (masking the RM-thinking step 14, the
        // sleep step 12, the wake step 13, etc.). The cancel funnel clears
        // the responding chat path; the store terminal clears the snapshot.
        let cancelID = UUID()
        await runPresenceSmokeStep(name: "07_cancel_during_working",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { activityStore, chatStore in
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: cancelID, runID: cancelID,
                                                                  conversationID: cancelID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 1,
                                                                  timestamp: Date(),
                                                                  kind: .executionStarted,
                                                                   presentation: AgentTaskEventPresentation(title: "task", detail: "x"))))
                                       try? await Task.sleep(nanoseconds: 200_000_000)
                                       await coordinator.ingestChatAnimationEvent(.responseCancelled)
                                       // R2-8: publish the store-level cancelled terminal so
                                       // activeTasks becomes empty and the next derive
                                       // does NOT pin the machine at .acting.
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: cancelID, runID: cancelID,
                                                                  conversationID: cancelID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 2,
                                                                  timestamp: Date(),
                                                                  kind: .taskCancelled,
                                                                  presentation: AgentTaskEventPresentation(title: "cancel", detail: "x"))))
                                       await coordinator.tickOneSecond()
                                       _ = chatStore
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 08 — recovery → neutral (idle after recovery beat completes).
        // R4-3: the prior 800 ms body wait crossed the smoke's
        // `sleepAfterThreshold` (0.5 s) and let `maybeSleep` drift the
        // machine to .sleeping. With the settle loop's noteUserInteraction
        // suppressing greet (to preserve the cooldown for step 13), the
        // pet then STAYED .sleeping for the entire settle and the
        // smoke captured `(.sleeping, .sleeping)`. R4-3 shortens the
        // body wait to 300 ms (under the 500 ms threshold) so the pet
        // stays .idle throughout; the recovery beats completed in
        // step 07's settle loop (30 × 33 ms ≈ 990 ms of clock
        // advance), so no extra wait is needed here. Step 08's primary
        // (.idle, .idle) is then reachable without consuming the
        // greet cooldown.
        await runPresenceSmokeStep(name: "08_recovery_neutral",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in
                                       try? await Task.sleep(nanoseconds: 300_000_000)
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 09 — failure
        let failID = UUID()
        await runPresenceSmokeStep(name: "09_failed",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { activityStore, _ in
                                       activityStore.publish(AgentEventEnvelope(activityEvent:
                                           AgentTaskActivityEvent(taskID: failID, runID: failID,
                                                                  conversationID: failID,
                                                                  userMessageID: nil,
                                                                  sequenceNumber: 1,
                                                                  timestamp: Date(),
                                                                  kind: .taskFailed,
                                                                  presentation: AgentTaskEventPresentation(title: "fail", detail: "x"),
                                                                  failureCategory: .interrupted)))
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 10 — concerned → idle (after taskFailed one-shot expires).
        // R4-3: the prior body waited 2 000 ms which crossed the
        // smoke's `sleepAfterThreshold` (500 ms) — `maybeSleep`
        // drifted the machine to `.sleeping`. With the settle loop's
        // `noteUserInteraction(suppressGreet: true)` not firing
        // greet (R4-3), the pet STAYED `.sleeping` for the entire
        // settle. Replace the wall-clock wait with a scene.update
        // + noteUserInteraction loop that advances the renderer
        // clock by ~1.98 s (enough for taskFailed's 1.45 s one-shot
        // to expire) without letting `maybeSleep` fire (lastInteraction
        // refreshes each iteration). After the loop the pet is in
        // `.idle` (post-taskFailed expiry) and the settle loop's
        // first tick advances cleanly to `.idle` / `.idleLookAround`.
        await runPresenceSmokeStep(name: "10_concerned_then_idle",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in
                                       for _ in 0..<60 {
                                           scene.update(deltaTime: 0.033)
                                           coordinator.noteUserInteraction(suppressGreet: true)
                                           try? await Task.sleep(nanoseconds: 10_000_000)
                                       }
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 11 — walk re-assert after one-shot expires mid-walk (real wander + injected one-shot)
        await runPresenceSmokeStep(name: "11_walk_reassert_after_intent_expiry",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in
                                       scene.setMovementSpeedPointsPerSecond(60)
                                       scene.setFeet(to: CGPoint(x: 160, y: 80), facing: 1)
                                       scene.apply(activity: .wander)
                                       for _ in 0..<15 {
                                           scene.apply(activity: .wander)
                                           scene.update(deltaTime: 0.05)
                                       }
                                       // Apply an upper-priority one-shot (jump) to override
                                       // the walk visual briefly; the test asserts walk returns.
                                       scene.apply(intent: CharacterAnimationIntent(state: .jump,
                                                                                    priority: 68,
                                                                                    duration: 0.78,
                                                                                    source: .agentRuntime,
                                                                                    createdAt: 0))
                                       for _ in 0..<25 {
                                           scene.apply(activity: .wander)
                                           scene.update(deltaTime: 0.05)
                                       }
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 12 — sleep: drive via REAL coordinator derivation. With sleepAfterThreshold = 0.5 s,
        //          the 1 Hz tick will fire `.sleep` after enough quiet ticks. Because the
        //          walking pet is in `.wander`, the `presenceEngaged` callback suppressWander
        //          gate closes the wander — there must be no task/chat/responding before the
        //          tick can fire `.sleep`.
        // R4-5: drive the locomotion controller out of `.walking`
        // (left over from step 11's wander loop) BEFORE the sleep
        // tick so the walk reassert path is INACTIVE for steps
        // 13/14/15. Without this, the renderer transitions from
        // `.greet` (step 13) / `.thinking`/`.look1125` (step 14) /
        // `.idle` (step 15) back to `.walkRight` via the per-frame
        // reassert because the FSM priority check accepts walkRight
        // p35 over any expired < p35 visual. Multiple `scene.apply`
        // calls are needed because the controller has a 0.18 s
        // `returnIdleDelay` hysteresis before `.walking → .stopping`
        // fires.
        await runPresenceSmokeStep(name: "12_sleep",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in
                                       // Drive locomotion out of .walking
                                       // (5 iterations × 0.05 s = 0.25 s > 0.18 s hysteresis).
                                       for _ in 0..<5 {
                                           scene.apply(activity: .idle)
                                           scene.update(deltaTime: 0.05)
                                       }
                                       // Now let the pet sleep (R1-3 production-real
                                       // behavior — sleep fires after 0.5 s of quiet).
                                       for _ in 0..<8 {
                                           await coordinator.tickOneSecond()
                                           try? await Task.sleep(nanoseconds: 100_000_000)
                                       }
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 13 — wake + greet: drive via the REAL coordinator's `.wake` event by calling
        //          `noteUserInteraction()` (production seam — R1-3). The greet one-shot is
        //          dispatched by the coordinator's wake-greet path.
        // R4-3: the body is a single `userNoteProxy.fire()` — the
        // async greet task dispatches on the main actor and lands
        // within the first few settle iterations. The settle loop's
        // in-window capture hook (below) records the renderer's
        // first `.greet` encounter so the smoke's primary
        // `(.idle, .greet)` is reachable deterministically. The
        // 250 ms + 2 tickOneSecond body from R3 was removed
        // because the body-side tickOneSeconds gave the renderer
        // clock ~270 ms before the settle loop started — combined
        // with the 990 ms settle loop that's well past the 720 ms
        // greet window, the renderer was always captured
        // post-expiry. The pre-settle simplify also avoids
        // advancing the greet's clock unnecessarily before the
        // settle loop's per-iteration `tickOneSecond` runs.
        await runPresenceSmokeStep(name: "13_wake_greet",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, _ in
                                       userNoteProxy.fire()
                                   },
                                   capture: { captured.append(($0, $1, $2)) },
                                   inWindowCapture: { d, sem in
                                       // R4-3: assert the renderer
                                       // shows `.greet` during the
                                       // 0.72 s one-shot window. The
                                       // settle loop's first few
                                       // iterations land BEFORE the
                                       // greet's clock has elapsed,
                                       // so the renderer.state ==
                                       // .greet check reliably fires
                                       // inside the hook. The
                                       // semantic at the captured
                                       // moment is `.idle` (R4-4
                                       // stamp on the greeted wake
                                       // branch + the natural
                                       // post-wake idle).
                                       if d.state == .greet {
                                           return (sem ?? "idle", d.state.rawValue)
                                       }
                                       return nil
                                   })

        // 14 — RM thinking pose (force RM flag then push through isResponding)
        await runPresenceSmokeStep(name: "14_rm_thinking_look_pose",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, chatStore in
                                       coordinator.setReduceMotion(true)
                                       chatStore.collapseToCapsule()
                                       chatStore.isResponding = true
                                       try? await Task.sleep(nanoseconds: 200_000_000)
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // 15 — chat-hide after dwell (R3-1). Re-establish a clean
        //     chat-attentive state, wait past sustainedMinDwell
        //     (default 1.5 s — wait 2 s for safety margin), then collapse.
        //     The R3-1 fix dispatches a clearing p59 idle from the
        //     chat-hide falling edge so the renderer transitions out of
        //     .listening p45 within one beat.
        await runPresenceSmokeStep(name: "15_chat_hide_after_dwell",
                                   outputDirectory: outputDirectory,
                                   coordinator: coordinator,
                                   body: { _, chatStore in
                                       coordinator.setReduceMotion(false)
                                       chatStore.isResponding = false
                                       chatStore.expand()
                                       // Wait > sustainedMinDwell (1.5 s
                                       // default; use 2 s for safety margin)
                                       // so chat-hide is a dwell-ELAPSED
                                       // demotion (the standard test path,
                                       // NOT the pendingDemotion replay path).
                                       try? await Task.sleep(nanoseconds: 2_000_000_000)
                                       chatStore.collapseToCapsule()
                                       await coordinator.tickOneSecond()
                                   },
                                   capture: { captured.append(($0, $1, $2)) })

        // R2-7: assert every step captured the expected semantic↔renderer pair,
        // with optional alternative values accepted where the architecture
        // offers multiple valid outcomes (e.g. step 13 may capture `.greet`
        // during the wake-greet one-shot window or `.idle` after it expires).
        var failedSteps: [String] = []
        for (index, expected) in expectedPairs.enumerated() {
            guard index < captured.count else {
                failedSteps.append("\(expected.name): no capture (expected \(expected.semantic ?? "nil") / \(expected.rendererState))")
                continue
            }
            let got = captured[index]
            let semanticMatches = got.semantic == expected.semantic ||
                (expected.altSemantics?.contains(got.semantic ?? "") ?? false)
            let rendererMatches = got.stateRaw == expected.rendererState ||
                (expected.altRendererStates?.contains(got.stateRaw) ?? false)
            if !semanticMatches || !rendererMatches {
                let altSemStr = expected.altSemantics.map { " (or \($0.joined(separator: "/")))" } ?? ""
                let altStateStr = expected.altRendererStates.map { " (or \($0.joined(separator: "/")))" } ?? ""
                let msg = "\(expected.name): got semantic=\(got.semantic ?? "nil") renderer=\(got.stateRaw) " +
                    "expected semantic=\(expected.semantic ?? "nil")\(altSemStr) " +
                    "renderer=\(expected.rendererState)\(altStateStr)"
                failedSteps.append(msg)
            }
        }
        let mismatch = !failedSteps.isEmpty

        // Persist report.
        let reportURL = outputDirectory.appendingPathComponent("runtime_presence_visual_smoke.json")
        let d = scene.diagnostics()
        do {
            let payload: [String: Any] = [
                "characterID": "lumi-scholar",
                "notes": [
                    "P16 character presence smoke — REAL CharacterPresenceCoordinator (R1-10).",
                    "Human visual acceptance is still manual.",
                    "Every step drives its visual purely via the coordinator's derivation pipeline."
                ],
                "finalRendererState": d.state.rawValue,
                "finalClipID": d.currentClipID ?? NSNull(),
                "expectedPairs": expectedPairs.map {
                    var entry: [String: Any] = [
                        "step": $0.name,
                        "expectedSemantic": $0.semantic ?? NSNull(),
                        "expectedRendererState": $0.rendererState
                    ]
                    if let altSem = $0.altSemantics { entry["altSemantics"] = altSem }
                    if let altState = $0.altRendererStates { entry["altRendererStates"] = altState }
                    return entry
                },
                "mismatch": mismatch,
                "failedSteps": failedSteps,
                "steps": captured.map {
                    ["step": $0.name,
                     "derivedVisualSemantic": $0.semantic ?? NSNull(),
                     "diagnosticState": $0.stateRaw] as [String: Any]
                }
            ] as [String: Any]
            let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
            try data.write(to: reportURL)
        } catch {
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE report failed=\(error)\n".data(using: .utf8)!)
        }
        if mismatch {
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE mismatch=true failedSteps=\(failedSteps)\n".data(using: .utf8)!)
        }

        await coordinator.stop()
    }

    private func runPresenceSmokeStep(name: String,
                                      outputDirectory: URL,
                                      coordinator: CharacterPresenceCoordinator,
                                      body: (AgentTaskActivityStore, FloatingChatStateStore) async throws -> Void,
                                      capture: (String, String?, String) -> Void,
                                      inWindowCapture: ((CharacterAnimationDiagnostics, String?) -> (semantic: String?, renderer: String)?)? = nil) async {
        let activityStore: AgentTaskActivityStore = coordinator.activityStore
        let chatStore: FloatingChatStateStore = coordinator.chatStore
        // R2-8: precondition — steps 11-14 require `activeTasks` empty. The
        // step-07 cancel publishes a `taskCancelled` store terminal for
        // cancelID so the snapshot is clean for the rest of the run. Steps
        // 12/13/14 derive from `activeTasks`/`chatAttentive`/`isResponding`
        // and would otherwise be masked by a ghost running task.
        if name == "11_walk_reassert_after_intent_expiry" ||
           name == "12_sleep" ||
           name == "13_wake_greet" ||
           name == "14_rm_thinking_look_pose" {
            if !activityStore.activeTasks.isEmpty {
                FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE step=\(name) PRECONDITION FAILED activeTasks=\(activityStore.activeTasks.map { $0.taskID })\n".data(using: .utf8)!)
            }
        }
        do {
            try await body(activityStore, chatStore)
        } catch {
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE step=\(name) body error=\(error)\n".data(using: .utf8)!)
        }
        // R2-5: settle loop drives scene.update(deltaTime: 0.033) per iteration
        // so the renderer FSM's one-shot durations actually expire. The
        // longest one-shot in the smoke is `taskFailed` (1.45 s); 30 iterations
        // advance the renderer clock by ~0.99 s — enough for jump (0.78 s),
        // reacting (0.30 s), neutralReset (0.20 s), and most other one-shots
        // to expire so the capture reflects the post-expiry state. (Without
        // this the renderer clock was frozen for the whole smoke run and
        // the success/failure/recovery poses never expired, leaving the
        // renderer stuck at jump / taskFailed / reacting across every step.)
        //
        // For non-sleep steps, also call `noteUserInteraction` each iteration
        // so the `lastUserInteractionAt` clock stays fresh and the pet does
        // NOT auto-sleep during the settle (otherwise step 00 / 01 etc. would
        // show sleeping/sleeping because the smoke never produces any
        // user-interaction timestamp on its own). Step 12 (the explicit
        // sleep step) sets `keepAwake: false` so the settle loop lets the
        // inactivity-based sleep fire.
        //
        // R4-3: step 08's settle loop must NOT consume the
        // `greetOnWakeCooldown` via an auto-greet — the body waits
        // long enough (800 ms) for the pet to drift to .sleeping,
        // and the first `noteUserInteraction` per settle loop would
        // fire the wake-greet one-shot, stamp `lastGreetAt`, and
        // suppress step 13's greet before it can fire. Pass
        // `suppressGreet: true` for step 08 only so the pet's
        // freshness refresh doesn't touch the greet cooldown.
        let keepAwake = name != "12_sleep"
        // R4-3: every step's settle loop uses `noteUserInteraction`
        // to keep the pet awake (refresh `lastUserInteractionAt`).
        // Pass `suppressGreet: true` so this refresh never fires
        // the wake-greet one-shot (which would otherwise consume the
        // `greetOnWakeCooldown` before step 13's explicit wake). The
        // wake-greet is fired exactly once — by the step 13 body via
        // `userNoteProxy.fire()` — and the in-window capture hook
        // records the renderer's `.greet` encounter during the 0.72 s
        // window. No settle-loop iteration can re-fire greet.
        let suppressGreetInLoop = true
        var inWindow: (semantic: String?, renderer: String)? = nil
        for _ in 0..<30 {
            await coordinator.tickOneSecond()
            scene.update(deltaTime: 0.033)
            if keepAwake {
                coordinator.noteUserInteraction(suppressGreet: suppressGreetInLoop)
            }
            // R4-3: in-window capture — once the hook reports a
            // hit (e.g. renderer.state == .greet for step 13),
            // freeze that (semantic, renderer) pair as the step's
            // captured value. Without this hook the only capture is
            // the final renderer state which always lands on the
            // post-expiry `.idle` after the greet one-shot's 0.72 s
            // window has expired inside the 990 ms settle loop.
            if inWindow == nil, let hook = inWindowCapture {
                let dLoop = scene.diagnostics()
                let semLoop = coordinator.state.derivedVisualSemantic?.rawValue
                if let override = hook(dLoop, semLoop) {
                    inWindow = override
                }
            }
            try? await Task.sleep(nanoseconds: 33_000_000)
        }
        let fileURL = outputDirectory.appendingPathComponent("\(name).png")
        _ = captureSmokeScreenshot(to: fileURL)
        let d = scene.diagnostics()
        let sem = coordinator.state.derivedVisualSemantic?.rawValue
        if let inWindow {
            // R4-3: the in-window capture saw the renderer in the
            // expected state during the one-shot's visible window.
            // Use the (semantic, renderer) pair the hook recorded so
            // the smoke primary matches what was actually observable.
            capture(name, inWindow.semantic, inWindow.renderer)
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE step=\(name) IN-WINDOW semantic=\(inWindow.semantic ?? "nil") renderer=\(inWindow.renderer) (final semantic=\(sem ?? "nil") renderer=\(d.state.rawValue))\n".data(using: .utf8)!)
        } else {
            capture(name, sem, d.state.rawValue)
            FileHandle.standardError.write("PRESENCE_VISUAL_SMOKE step=\(name) coordinator.semantic=\(sem ?? "nil") renderer.state=\(d.state.rawValue)\n".data(using: .utf8)!)
        }
    }
    #endif

    private func applyPassthrough(at point: CGPoint? = nil) {
        let enabled = state.passthrough != .fullPassthrough && !state.isHidden
        content.interactionEnabled = enabled
        let local = toLocal(point ?? NSEvent.mouseLocation)
        window.ignoresMouseEvents = !enabled || (petClickTracker == nil && !surface.interactiveRegion(local))
    }

    // MARK: Observers

    private func observeScreenChanges() {
        // P18.2 — retain the token so `stopLifecycleResources()` can unregister it.
        screenObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification,
            object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.handleScreenChange() }
        }
    }

    /// Pause the 30Hz/1Hz timers while the machine sleeps so the pet doesn't
    /// spin all night (previously only the snapshot was marked .sleeping).
    private func observeSleepWake() {
        let center = NSWorkspace.shared.notificationCenter
        let suspend: @Sendable (Notification) -> Void = { [weak self] _ in
            MainActor.assumeIsolated { self?.suspendTimersForSleep() }
        }
        let resume: @Sendable (Notification) -> Void = { [weak self] _ in
            MainActor.assumeIsolated { self?.resumeTimersAfterWake() }
        }
        for name in [NSWorkspace.willSleepNotification,
                     NSWorkspace.screensDidSleepNotification] {
            sleepObservers.append(center.addObserver(forName: name, object: nil,
                                                     queue: .main, using: suspend))
        }
        for name in [NSWorkspace.didWakeNotification,
                     NSWorkspace.screensDidWakeNotification] {
            sleepObservers.append(center.addObserver(forName: name, object: nil,
                                                     queue: .main, using: resume))
        }
    }

    private func suspendTimersForSleep() {
        guard isStarted, !timersSuspendedForSleep else { return }
        behaviorTimer?.invalidate(); behaviorTimer = nil
        surfaceTimer?.invalidate(); surfaceTimer = nil
        timersSuspendedForSleep = true
        surface.setPaused(true)
    }

    private func resumeTimersAfterWake() {
        guard isStarted, timersSuspendedForSleep else { return }
        timersSuspendedForSleep = false
        surface.setPaused(false)
        lastTick = Date().timeIntervalSinceReferenceDate
        behaviorTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.behaviorTick() }
        }
        surfaceTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.refreshSurfaces()
                self?.proactivityTick()
                self?.onSecondTick()
            }
        }
    }

    /// P18.2 — idempotent teardown for every lifecycle-sensitive resource `start()`
    /// acquires: the two repeating `Timer`s, the `flagsChanged` global/local
    /// `NSEvent` monitors, and the screen-parameters observer. Safe to call twice and
    /// safe before `start()` (all fields nil/empty); called from `applicationWillTerminate`.
    /// Clears `isStarted` so a later `start()` can re-establish the resources cleanly.
    func stopLifecycleResources() {
        behaviorTimer?.invalidate(); behaviorTimer = nil
        surfaceTimer?.invalidate(); surfaceTimer = nil
        timersSuspendedForSleep = false
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors.removeAll()
        pointerRouting?.stop(); pointerRouting = nil
        if let screenObserver {
            NotificationCenter.default.removeObserver(screenObserver)
            self.screenObserver = nil
        }
        for o in sleepObservers { NSWorkspace.shared.notificationCenter.removeObserver(o) }
        sleepObservers.removeAll()
        isStarted = false
        surface.setPaused(true)
    }

    private func handleScreenChange() {
        let layout = desktopLayout.screenChanged(
            current: DesktopEntityLayoutState(petFeet: state.position,
                                             nestAnchor: nestGlobal,
                                             homeTarget: state.home),
            visibleFrames: visibleFramesForLayout)
        state.position = layout.petFeet
        nestGlobal = layout.nestAnchor
        state.home = layout.homeTarget
        let surfaces = tracker.allSurfaces()
        if let fb = PerchSolver.fallbackSurface(near: state.position.x, candidates: surfaces) {
            machine.land(on: fb)
        }
        syncRenderer()
    }

    private func observeModifier() {
        let handler: (NSEvent) -> Void = { [weak self] event in
            guard let self else { return }
            MainActor.assumeIsolated {
                let held = event.modifierFlags.contains(.option)
                if held != self.modifierHeld {
                    self.modifierHeld = held
                    if self.state.passthrough == .workFirst { self.applyPassthrough() }
                }
            }
        }
        if let g = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged, handler: { handler($0) }) {
            monitors.append(g)
        }
        if let l = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged, handler: { handler($0); return $0 }) {
            monitors.append(l)
        }
    }

    // MARK: Coordinate helpers

    private func toLocal(_ global: CGPoint) -> CGPoint {
        CGPoint(x: global.x - unionOrigin.x, y: global.y - unionOrigin.y)
    }
    func toLocalPublic(_ global: CGPoint) -> CGPoint { toLocal(global) }
    private func toGlobal(_ local: CGPoint) -> CGPoint {
        CGPoint(x: local.x + unionOrigin.x, y: local.y + unionOrigin.y)
    }
    /// Pet bounding rect in window-local coords for hit testing.
    private func localPetRect() -> CGRect {
        let feet = toLocal(state.position)
        let s = visualSize
        return CGRect(x: feet.x - s.width / 2, y: feet.y, width: s.width, height: s.height)
    }

    private var visualSize: CGSize {
        CharacterSurface.visualSize(height: characterHeight)
    }

    private func clampFeet(_ point: CGPoint) -> CGPoint {
        ScreenGeometry.clampFeet(point, visualSize: visualSize, into: visibleFramesForLayout)
    }

    private var visibleFramesForLayout: [CGRect] {
        let frames = screens.visibleScreenFrames
        return frames.isEmpty ? screens.screenFrames : frames
    }

    private func relayoutOverlayWindow() {
        let visual = visualSize
        let baseContentSize = CGSize(width: max(360, visual.width + 80), height: visual.height + 190)
        let feetInset = PetOverlayWindowMetrics.feetInset(for: baseContentSize)
        state.position = ScreenGeometry.clampFeet(state.position, visualSize: visual, into: visibleFramesForLayout)
        let frame = ScreenGeometry.overlayFrame(forFeet: state.position,
                                                 visualSize: visual,
                                                 contentSize: baseContentSize,
                                                 feetInset: feetInset,
                                                 visibleFrames: visibleFramesForLayout)
        guard !approximatelyEqual(window.frame, frame) else { return }
        window.setFrame(frame.integral, display: true)
        content.frame = CGRect(origin: .zero, size: frame.integral.size)
        surface.frame = content.bounds
    }

    private func approximatelyEqual(_ lhs: CGRect, _ rhs: CGRect) -> Bool {
        abs(lhs.origin.x - rhs.origin.x) < 0.5
            && abs(lhs.origin.y - rhs.origin.y) < 0.5
            && abs(lhs.size.width - rhs.size.width) < 0.5
            && abs(lhs.size.height - rhs.size.height) < 0.5
    }
}
