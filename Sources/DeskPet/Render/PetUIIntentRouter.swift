import Foundation
import AppKit

// P5.1 — 主窗口 UI → 桌宠动画的桥接（doc §13）。UI 不直接操作 PetRenderer 内部状态，也不散落字符串
// 事件名：UI 发出强类型 `PetUIIntent`，由 Router 节流/去抖后映射到现有 animation FSM 入口
// （overlay.handleAgentAnimationEvent / reactPet）。不新增第二套动画系统。

/// 主窗口可以发出的语义意图（强类型，非字符串）。
enum PetUIIntent: Equatable, Sendable {
    case windowOpened          // 用户打开主窗口 → 角色短暂注意
    case navigationChanged     // 切换导航 → 轻微注意（高频，需节流）
    case focusStarted          // 进入专注 → 低干扰陪伴
    case focusPaused           // 暂停专注 → 恢复轻微动作
    case taskCompleted         // 完成任务 → 积极反馈
    case focusCompleted        // 完成专注 → 积极反馈
    case runtimeAttention      // Runtime 输出到来 → 注意
    case permissionBlocked     // 能力被拒 → 轻微困惑（非“生气”）
}

/// Router 协议——便于注入测试用记录实现。
@MainActor
protocol PetUIIntentRouting: AnyObject {
    func send(_ intent: PetUIIntent)
}

/// 节流策略：对高频意图（navigationChanged）做最小间隔去抖，避免每次切页都播放完整动画。
@MainActor
final class PetUIIntentRouter: PetUIIntentRouting {
    private let sink: (PetAgentAnimationEvent) -> Void
    private let now: () -> TimeInterval
    private let navThrottle: TimeInterval
    private var lastNavAt: TimeInterval = -1000
    private(set) var deliveredCount = 0

    /// - Parameters:
    ///   - navThrottle: navigationChanged 的最小间隔（秒）。
    ///   - now: 时间源（测试可注入）。
    ///   - sink: 映射后的动画事件出口（生产环境为 overlay.handleAgentAnimationEvent）。
    init(navThrottle: TimeInterval = 0.6,
         now: @escaping () -> TimeInterval = { Date().timeIntervalSinceReferenceDate },
         sink: @escaping (PetAgentAnimationEvent) -> Void) {
        self.navThrottle = navThrottle
        self.now = now
        self.sink = sink
    }

    func send(_ intent: PetUIIntent) {
        if intent == .navigationChanged {
            let t = now()
            guard t - lastNavAt >= navThrottle else { return }   // 去抖
            lastNavAt = t
        }
        guard let event = Self.animationEvent(for: intent) else { return }
        deliveredCount += 1
        sink(event)
    }

    /// 将 UI 意图映射到现有 animation FSM 事件。缺少专属动作时退化到最接近的轻量反馈。
    static func animationEvent(for intent: PetUIIntent) -> PetAgentAnimationEvent? {
        switch intent {
        case .windowOpened, .navigationChanged, .runtimeAttention:
            return .userMessageReceived          // 轻微注意/看向
        case .focusStarted:
            return .thinkingStarted              // 进入专注陪伴（低干扰）
        case .focusPaused:
            return .thinkingFinished             // 恢复轻微 idle
        case .taskCompleted, .focusCompleted:
            return .responseFinished(emotion: .happy)   // 积极反馈（经现有 FSM）
        case .permissionBlocked:
            return .emotionChanged(.thinking)    // 轻微困惑（非生气）
        }
    }
}

/// 无操作 Router（默认/无 overlay 时）。
@MainActor
final class NoopPetIntentRouter: PetUIIntentRouting {
    func send(_ intent: PetUIIntent) {}
}
