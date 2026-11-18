import AppKit
@preconcurrency import ApplicationServices

/// Synchronizes this app's window hit policy before events receive an app target.
/// Does not monitor keys, store input, suppress, replace or repost events.
@MainActor
final class PointerRoutingTap {
    /// CF teardown is thread-safe and belongs to this lease, including when
    /// ARC releases the MainActor owner from a nonisolated context.
    private final class TapLease {
        let port: CFMachPort
        init(_ port: CFMachPort) { self.port = port }
        deinit { CFMachPortInvalidate(port) }
    }
    private var lease: TapLease?
    private var port: CFMachPort? { lease?.port }
    private var source: CFRunLoopSource?
    private let update: (CGPoint) -> Void
    init(update: @escaping (CGPoint) -> Void) { self.update = update }
    func start() -> Bool {
        guard port == nil else { return true }
        let types: [CGEventType] = [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                         options: .defaultTap, eventsOfInterest: mask,
                                         callback: { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            MainActor.assumeIsolated {
                let owner = Unmanaged<PointerRoutingTap>.fromOpaque(context).takeUnretainedValue()
                if type == .tapDisabledByTimeout {
                    if let port = owner.port { CGEvent.tapEnable(tap: port, enable: true) }
                } else if [.mouseMoved, .leftMouseDown, .leftMouseUp, .leftMouseDragged].contains(type) {
                    let point = event.location
                    let top = NSScreen.screens.first?.frame.maxY ?? 0
                    owner.update(CGPoint(x: point.x, y: top - point.y))
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else {
            NSLog("Pointer routing tap unavailable; accessibilityTrusted=%@", AXIsProcessTrusted() ? "true" : "false")
            // Ask macOS to present its own authorization UI. This neither grants
            // access nor changes TCC; tests and non-app callers never prompt.
            if !AXIsProcessTrusted(), Bundle.main.bundleIdentifier == "com.deskpet.companion" {
                let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
                _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
            }
            return false
        }
        guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            CFMachPortInvalidate(tap)
            return false
        }
        lease = TapLease(tap)
        source = runLoopSource
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        NSLog("Pointer routing tap installed")
        return true
    }
    func stop() {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let port { CFMachPortInvalidate(port) }
        source = nil; lease = nil
        NSLog("Pointer routing tap stopped")
    }
}
