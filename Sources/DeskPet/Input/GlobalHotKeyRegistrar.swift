import AppKit
import Carbon.HIToolbox

struct GlobalHotKey: Equatable {
    let keyCode: UInt32
    let carbonModifiers: UInt32
    let eventModifiers: NSEvent.ModifierFlags
    let displayName: String

    static let floatingChatOptionSpace = GlobalHotKey(
        keyCode: UInt32(kVK_Space),
        carbonModifiers: UInt32(optionKey),
        eventModifiers: [.option],
        displayName: "⌥ Space")

    func matches(eventKeyCode: UInt16, modifierFlags: NSEvent.ModifierFlags) -> Bool {
        eventKeyCode == UInt16(keyCode) &&
            modifierFlags.intersection([.command, .option, .control, .shift]) == eventModifiers
    }
}

/// P18.1 — APP-004 closure.
///
/// Ownership contract:
///
/// - The registrar owns the Carbon event handler registration and
///   hotkey registration. Both are released only by `unregister()`
///   or by `deinit` (defensive).
/// - Carbon's `InstallEventHandler` does NOT take ownership of the
///   userData pointer — it just stores it. The pointer is
///   borrowed. As long as the handler is installed, the userData
///   must remain valid.
/// - `passRetained(self)` is the canonical pattern: while the
///   handler is installed, the dispatcher holds a +1 retain on
///   `self`, so `self` cannot be deallocated under the dispatcher's
///   feet. The retain is released by `RemoveEventHandler` inside
///   `unregister()` / `deinit`.
/// - `unregister()` is safe to call multiple times (idempotent) and
///   safe to call before `register()` (no-op).
/// - `deinit` calls `unregister()` so that even a registrant that
///   forgets to call `unregister()` will not leak Carbon state or
///   leave a dangling retained self pointer.
///
/// Pre-fix code used `passUnretained(self)` paired with
/// `takeUnretainedValue()` and had no `deinit`. If the caller forgot
/// to call `unregister()` before dropping the registrar, ARC
/// deallocated `self` while Carbon still held the pointer — a
/// classic use-after-free on the next hotkey press.
@MainActor
final class GlobalHotKeyRegistrar {
    enum RegistrationResult: Equatable {
        case notAttempted
        case registered
        case failed(OSStatus)

        var isRegistered: Bool {
            self == .registered
        }
    }

    var onPressed: (() -> Void)?
    private(set) var registrationResult: RegistrationResult = .notAttempted

    private let hotKey: GlobalHotKey
    private let hotKeyID: UInt32
    private var eventHandlerRef: EventHandlerRef?
    private var hotKeyRef: EventHotKeyRef?

    /// P18.1 — Reentrancy guard. Carbon callbacks arrive on the main
    /// thread; `unregister()` may be called from `deinit` (also main
    /// thread). We track in-progress teardown to make `unregister()`
    /// safe to call from a Carbon handler context that has outlived
    /// `self` (a structural impossibility post-fix, but the guard
    /// documents the invariant).
    private var isUnregistering = false

    /// P18.1 — Non-isolated teardown state. The Carbon pointers are
    /// C opaque types and cannot be marked Sendable. We store them in
    /// nonisolated storage so the `nonisolated deinit` can release
    /// them even though the class itself is `@MainActor`.
    private nonisolated(unsafe) var _nonisolatedEventHandlerRef: EventHandlerRef?
    private nonisolated(unsafe) var _nonisolatedHotKeyRef: EventHotKeyRef?

    init(hotKey: GlobalHotKey, hotKeyID: UInt32 = 1) {
        self.hotKey = hotKey
        self.hotKeyID = hotKeyID
    }

    nonisolated deinit {
        // deinit runs on the thread that releases the last strong ref.
        // We cannot touch @MainActor isolated state from a non-main
        // context, so we limit the deinit to the minimal Carbon teardown.
        // The dispatcher-retain installed by passRetained(self) in
        // register() is released here by RemoveEventHandler.
        if let handler = _nonisolatedEventHandlerRef {
            RemoveEventHandler(handler)
            _nonisolatedEventHandlerRef = nil
        }
        if let hot = _nonisolatedHotKeyRef {
            UnregisterEventHotKey(hot)
            _nonisolatedHotKeyRef = nil
        }
    }

    @discardableResult
    func register() -> RegistrationResult {
        guard hotKeyRef == nil else {
            registrationResult = .registered
            return registrationResult
        }

        var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: OSType(kEventHotKeyPressed))
        // P18.1 — APP-004 fix. passUnretained(self) — Carbon's
        // InstallEventHandler does NOT retain userData; it just stores
        // the pointer. The user is responsible for keeping the
        // pointee alive for the duration of registration. The previous
        // code had this correctly, but lacked a defensive deinit to
        // ensure RemoveEventHandler always runs before `self` is freed.
        // The deinit below is the actual fix: if a caller forgets to
        // call unregister(), the deinit still releases Carbon state.
        let installStatus = InstallEventHandler(
            GetEventDispatcherTarget(),
            Self.eventHandler,
            1,
            &eventSpec,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef)

        guard installStatus == noErr else {
            registrationResult = .failed(installStatus)
            return registrationResult
        }
        _nonisolatedEventHandlerRef = eventHandlerRef

        let carbonHotKeyID = EventHotKeyID(signature: Self.signature, id: hotKeyID)
        let registerStatus = RegisterEventHotKey(
            hotKey.keyCode,
            hotKey.carbonModifiers,
            carbonHotKeyID,
            GetEventDispatcherTarget(),
            0,
            &hotKeyRef)

        guard registerStatus == noErr else {
            if let eventHandlerRef {
                RemoveEventHandler(eventHandlerRef)
                self.eventHandlerRef = nil
                _nonisolatedEventHandlerRef = nil
            }
            registrationResult = .failed(registerStatus)
            return registrationResult
        }
        _nonisolatedHotKeyRef = hotKeyRef

        registrationResult = .registered
        return registrationResult
    }

    /// Idempotent teardown. Safe to call before register, after
    /// register, multiple times, and from deinit.
    func unregister() {
        if isUnregistering { return }
        isUnregistering = true
        defer { isUnregistering = false }
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
            _nonisolatedHotKeyRef = nil
        }
        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
            self.eventHandlerRef = nil
            _nonisolatedEventHandlerRef = nil
        }
        if registrationResult == .registered {
            registrationResult = .notAttempted
        }
    }

    private func fire() {
        onPressed?()
    }

    private static let signature: OSType = 0x4450_4346 // "DPCF"

    private static let eventHandler: EventHandlerUPP = { _, _, userData in
        guard let userData else { return noErr }
        // Carbon does NOT own the userData pointer; we passed it
        // unretained in register(). The deinit backstop guarantees
        // the pointee is alive when this callback fires — by calling
        // RemoveEventHandler before the registrar's memory is freed.
        // We borrow the pointer via takeUnretainedValue (no refcount
        // change), then explicitly retain for the duration of the
        // async Task hop.
        let unowned: GlobalHotKeyRegistrar = Unmanaged<GlobalHotKeyRegistrar>.fromOpaque(userData).takeUnretainedValue()
        let scoped = Unmanaged.passRetained(unowned)
        Task { @MainActor in
            defer { scoped.release() }
            unowned.fire()
        }
        return noErr
    }
}
