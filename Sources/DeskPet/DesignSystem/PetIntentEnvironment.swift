import SwiftUI

// P5.1 — 把"发送桌宠意图"作为环境能力注入 SwiftUI。默认无操作；AppDelegate 注入真正连到 overlay 的
// 实现。View 只调用 `sendPetIntent(.xxx)`，不接触 PetRenderer。

private struct PetIntentSendKey: EnvironmentKey {
    static let defaultValue: @MainActor (PetUIIntent) -> Void = { _ in }
}

extension EnvironmentValues {
    var sendPetIntent: @MainActor (PetUIIntent) -> Void {
        get { self[PetIntentSendKey.self] }
        set { self[PetIntentSendKey.self] = newValue }
    }
}

// 窗口形态切换：由持有 NSWindow 的 MainWindowController 注入；默认无操作。
private struct SetWindowModeKey: EnvironmentKey {
    static let defaultValue: @MainActor (WindowMode) -> Void = { _ in }
}

extension EnvironmentValues {
    var setWindowMode: @MainActor (WindowMode) -> Void {
        get { self[SetWindowModeKey.self] }
        set { self[SetWindowModeKey.self] = newValue }
    }
}
