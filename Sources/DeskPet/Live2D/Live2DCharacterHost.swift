import AppKit
import WebKit

/// One visual instance, isolated bridge and model identity. Desktop geometry belongs to its owner.
@MainActor
final class Live2DCharacterHost {
    let bridge: Live2DBridge
    let instanceID = UUID()
    private(set) var selection: CharacterModelSelection?
    private(set) var capabilities = CharacterModelCapabilities()
    private(set) var loaded = false
    private(set) var error: String?
    private(set) var commandWarning: String?
    private(set) var lastDeclaredHitArea: String?
    private(set) var occupancy: CharacterOccupancy?
    var frame: CGRect = .zero { didSet { bridge.webView.frame = frame } }
    var onChange: (() -> Void)?
    var onEvent: ((Live2DEvent) -> Void)?
    #if DEBUG
    var occupancyCaptureEnabled = true
    #endif
    private var snapshotPending = false
    private var lastSnapshot = -Double.infinity
    private var generation = 0
    private let root: URL
    private var ready = false
    private var paused = false
    private var visible = true
    private var started = false
    private var lastState = CharacterSurfaceState()
    private var appliedExpression: String?

    init(root: URL = Live2DLocalResources.managedModelDirectory) {
        self.root = root
        bridge = Live2DBridge(modelDirectory: root)
        bridge.onEvent = { [weak self] event in self?.receive(event) }
    }
    func start(selection: CharacterModelSelection?) {
        self.selection = selection
        guard !started else { reload(selection: selection); return }
        started = true
        bridge.start()
    }
    func reload(selection: CharacterModelSelection?) {
        self.selection = selection
        error = nil
        generation += 1; occupancy = nil; loaded = false
        if ready { loadSelection() } else { bridge.reload() }
    }
    private func loadSelection() {
        guard let selection, let source = selection.source(within: root),
              let file = Live2DLocalResources.resolved(source, within: root, runtime: false),
              FileManager.default.fileExists(atPath: file.path) else {
            bridge.send(.unload)
            fail("未配置角色模型。请选择本机 Live2D ZIP 模型，或检查 characters.json。")
            return
        }
        error = nil; onChange?()
        bridge.send(.load, ["source": source.absoluteString, "appearanceExpressions": selection.appearanceExpressions ?? []])
    }
    private func receive(_ event: Live2DEvent) {
        switch event.kind {
        case .runtimeReady: ready = true; loadSelection()
        case .modelLoading: generation += 1; loaded = false; occupancy = nil; lastDeclaredHitArea = nil; capabilities = CharacterModelCapabilities()
        case .modelLoaded:
            loaded = true; error = nil; capabilities = CharacterModelCapabilities(payload: event.payload)
            apply(lastState, force: true)
        case .modelLoadFailed: fail(event.payload["message"] as? String ?? "角色模型不可用")
        case .runtimeError:
            if event.payload["fatal"] as? Bool == false {
                commandWarning = event.payload["message"] as? String
                NSLog("Live2D optional command rejected: %@", commandWarning ?? "unknown")
            } else { fail(event.payload["message"] as? String ?? "角色渲染器不可用") }
        case .hitArea:
            if let name = event.payload["name"] as? String, capabilities.hitAreas.contains(name) { lastDeclaredHitArea = name }
        case .capabilities: capabilities = CharacterModelCapabilities(payload: event.payload)
        default: break
        }
        onEvent?(event); onChange?()
    }
    private func fail(_ message: String) {
        error = message; loaded = false; occupancy = nil
        NSLog("Live2D character %@ unavailable: %@", instanceID.uuidString, message)
        onChange?()
    }
    func apply(_ state: CharacterSurfaceState, force: Bool = false) {
        let previous = lastState; lastState = state; visible = state.visible
        bridge.webView.isHidden = !visible
        guard ready, loaded else { return }
        if force || previous.visible != state.visible { bridge.setSuspended(!state.visible || paused, reason: "surface") }
        if force || previous.intent != state.intent {
            let semantic = state.intent.state.rawValue
            if semantic != "idle", let motion = capabilities.motion(for: semantic) { bridge.send(.motion, ["group": motion.group,"index":motion.index]) }
        }
        let expression = CharacterExpressionResolver.expression(for: state, available: capabilities.expressions)
        if force || expression != appliedExpression {
            appliedExpression = expression
            if let expression { bridge.send(.expression, ["name": expression]) }
            else { bridge.send(.clearExpression) }
        }
        let focus = state.dragging ? nil : state.attentionTarget.flatMap { Live2DFocusGeometry.normalized(pointer: $0, contentRect: frame) }
        bridge.setState(Live2DCharacterState(speaking: state.mouthOpenness > 0, mouthOpenness: state.mouthOpenness, attention: focus), force: force)
    }
    func setPaused(_ value: Bool) {
        guard paused != value else { return }; paused = value
        if ready { bridge.setSuspended(value || !visible, reason: "surface") }
    }
    func hit(_ point: CGPoint) -> Bool { loaded && visible && occupancy?.contains(point, in: frame) == true }
    var visualBounds: CGRect { occupancy?.visualBounds(in: frame) ?? .zero }
    var bubbleAnchor: CGPoint { CGPoint(x:visualBounds.midX,y:visualBounds.maxY+8) }
    func sendHit(_ point: CGPoint) {
        guard hit(point) else { return }
        bridge.send(.hitTest, ["x":point.x-frame.minX,"y":frame.maxY-point.y])
        // Models without declared hit areas retain only the generic character click.
    }
    func refreshOccupancy(now: TimeInterval) {
        #if DEBUG
        guard occupancyCaptureEnabled else { return }
        #endif
        guard loaded, visible, !paused, !bridge.suspended, !snapshotPending, now-lastSnapshot >= 0.25,
              frame.width > 0, frame.height > 0 else { return }
        snapshotPending = true; lastSnapshot = now
        let token = generation
        let config = WKSnapshotConfiguration(); config.snapshotWidth = 96
        bridge.webView.takeSnapshot(with: config) { [weak self] image, error in
            guard let self else { return }
            self.snapshotPending = false
            guard token == self.generation, self.loaded else { return }
            guard error == nil, let image, let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return }
            let width = cg.width, height = cg.height
            guard width > 0, height > 0, width * height <= 262144 else { return }
            var bytes = [UInt8](repeating: 0, count: width * height * 4)
            bytes.withUnsafeMutableBytes { raw in
                guard let context = CGContext(data: raw.baseAddress, width: width, height: height, bitsPerComponent: 8,
                                              bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
                context.draw(cg, in: CGRect(x: 0,y: 0,width: width,height: height))
            }
            self.occupancy = CharacterOccupancy(width: width,height: height,alpha: stride(from: 3,to: bytes.count,by: 4).map { bytes[$0] })
            self.onChange?()
        }
    }
    func close() { generation += 1; bridge.close(); loaded = false; occupancy = nil }
}
