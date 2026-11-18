import AppKit
import WebKit

@MainActor
private final class Live2DMessageProxy: NSObject, WKScriptMessageHandler {
    weak var owner: Live2DBridge?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.protocol == "deskpet",
              message.frameInfo.securityOrigin.host == "runtime" else { return }
        owner?.receive(message.body)
    }
}

@MainActor
final class Live2DBridge: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let proxy = Live2DMessageProxy()
    private var ready = false
    private var commandTail: Task<Void, Never>?
    private var generation = 0
    private var suspensionReasons = Set<String>()
    private(set) var suspended = false
    private var lastFocus: CGPoint?
    var onEvent: ((Live2DEvent) -> Void)?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private var pointerTimer: Timer?
    private(set) var state = Live2DCharacterState()

    init(modelDirectory: URL = Live2DLocalResources.managedModelDirectory, runtimeDirectory: URL? = nil) {
        let runtime = runtimeDirectory ?? Bundle.main.resourceURL!.appendingPathComponent("Live2DRuntime")
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.setURLSchemeHandler(Live2DLocalResources(runtimeRoot: runtime, modelRoot: modelDirectory), forURLScheme: "deskpet")
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        proxy.owner = self
        config.userContentController.add(proxy, name: "live2d")
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = false
        for (center, name, pause) in [
            (NSWorkspace.shared.notificationCenter,NSWorkspace.willSleepNotification,true),
            (NSWorkspace.shared.notificationCenter,NSWorkspace.didWakeNotification,false),
            (NotificationCenter.default,NSApplication.didHideNotification,true),
            (NotificationCenter.default,NSApplication.didUnhideNotification,false)
        ] {
            let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.setSuspended(pause, reason: name == NSApplication.didHideNotification || name == NSApplication.didUnhideNotification ? "applicationHidden" : "systemSleep") }
            }
            observers.append((center,token))
        }
    }
    func start() { generation += 1; commandTail?.cancel(); commandTail = nil; state = Live2DCharacterState(); ready = false; webView.load(URLRequest(url: URL(string:"deskpet://runtime/index.html")!)) }
    func reload() { start() }
    func close() {
        ready = false; generation += 1; commandTail?.cancel(); commandTail = nil
        pointerTimer?.invalidate(); pointerTimer = nil
        for (center, token) in observers { center.removeObserver(token) }; observers.removeAll()
        webView.stopLoading(); webView.configuration.userContentController.removeScriptMessageHandler(forName:"live2d")
        webView.navigationDelegate = nil; proxy.owner = nil; onEvent = nil
    }
    fileprivate func receive(_ body: Any) {
        guard let event = Live2DEvent.decode(body) else { fail("Invalid renderer event"); return }
        if event.kind == .runtimeReady {
            ready = true
            #if DEBUG
            send(.initialize, ProcessInfo.processInfo.arguments.contains("--live2d-disable-preserve") ? ["preserveDrawingBuffer": false] : [:])
            #else
            send(.initialize)
            #endif
        }
        onEvent?(event)
    }
    @discardableResult
    func send(_ type: Live2DCommandType, _ payload: [String: Any] = [:]) -> String {
        let id = UUID().uuidString
        guard ready, JSONSerialization.isValidJSONObject(payload) else { fail("Renderer unavailable or invalid payload"); return id }
        if type == .pause { suspended = true }
        if type == .resume {
            if !suspensionReasons.isEmpty { return id }
            suspended = false
        }
        let message: [String: Any] = ["version":1,"id":id,"type":type.rawValue,"payload":payload]
        // Arguments are serialized by WebKit; no string interpolation into JavaScript source.
        let previous = commandTail
        let token = generation
        commandTail = Task { @MainActor [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled, token == self.generation else { return }
            do { _ = try await self.webView.callAsyncJavaScript("await window.deskpetLive2D.dispatch(message)", arguments:["message":message], in:nil, contentWorld:.page) }
            catch { self.fail(error.localizedDescription) }
        }
        return id
    }
    func setSuspended(_ value: Bool, reason: String) {
        if value { suspensionReasons.insert(reason) } else { suspensionReasons.remove(reason) }
        let shouldPause = !suspensionReasons.isEmpty
        if ready, shouldPause != suspended { send(shouldPause ? .pause : .resume) }
    }
    func setState(_ value: Live2DCharacterState, force: Bool = false) {
        guard value.mouthOpenness.isFinite else { fail("Invalid mouth openness"); return }
        if force || state.speaking != value.speaking {send(.speaking,["speaking":value.speaking])}
        if force || state.mouthOpenness != value.mouthOpenness {send(.mouth,["openness":min(1,max(0,value.mouthOpenness))])}
        if force || state.attention != value.attention {
            let p = value.attention ?? .zero
            send(.focus,["x":min(1,max(-1,p.x)),"y":min(1,max(-1,p.y)),"active":value.attention != nil])
        }
        state=value
    }
    func stopTrackingPointer() {pointerTimer?.invalidate();pointerTimer=nil;lastFocus=nil}
    func trackPointer() {
        pointerTimer?.invalidate()
        pointerTimer=Timer.scheduledTimer(withTimeInterval:1.0/15.0,repeats:true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let window=self.webView.window, self.ready, !self.suspended else {return}
                let rect=window.convertToScreen(self.webView.convert(self.webView.bounds,to:nil))
                guard let point=Live2DFocusGeometry.normalized(pointer:NSEvent.mouseLocation,contentRect:rect) else {return}
                if let last=self.lastFocus, hypot(last.x-point.x,last.y-point.y)<0.005 {return}
                self.lastFocus=point
                self.send(.focus,["x":point.x,"y":point.y,"active":true])
            }
        }
    }
    private func fail(_ message: String) { onEvent?(Live2DEvent(kind:.runtimeError,id:nil,payload:["message":message])) }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        let url=navigationAction.request.url
        decisionHandler(url?.absoluteString == "deskpet://runtime/index.html" && navigationAction.targetFrame?.isMainFrame == true ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail(error.localizedDescription) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {ready=false;fail("WebKit renderer terminated; explicit reload required")}
}
