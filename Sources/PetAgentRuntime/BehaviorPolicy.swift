import Foundation
import AICore
import PetBrainCore

// P5.0 — proactivity modes & behavior policy (doc §6.6). Reuses the existing ProactiveMode and the
// deterministic ProactivePolicyEngine rather than inventing a parallel enum. Mode → naming map:
//   quiet → quiet, companion → companion (DEFAULT), active → assistant, agentWorking → agent.
// The policy decides whether/how the pet may act proactively; it never bypasses the PermissionGate —
// even `agentWorking` must still pass capability checks for any side effect.

/// Injected environment snapshot. P5.0 does not implement real meeting/battery detection; these are
/// seams the app fills later. Defaults are all benign.
public struct EnvironmentContext: Sendable, Equatable {
    public var isFullscreen: Bool
    public var inMeeting: Bool
    public var doNotDisturb: Bool
    public var lowBattery: Bool
    public var highSystemLoad: Bool
    public var userBusy: Bool

    public init(isFullscreen: Bool = false, inMeeting: Bool = false, doNotDisturb: Bool = false,
                lowBattery: Bool = false, highSystemLoad: Bool = false, userBusy: Bool = false) {
        self.isFullscreen = isFullscreen
        self.inMeeting = inMeeting
        self.doNotDisturb = doNotDisturb
        self.lowBattery = lowBattery
        self.highSystemLoad = highSystemLoad
        self.userBusy = userBusy
    }

    public static let normal = EnvironmentContext()
}

public struct BehaviorModeDecision: Sendable, Equatable {
    public var allowProactive: Bool
    public var cooldown: TimeInterval
    public var maxConsecutiveProactive: Int
    public var allowInterruptUser: Bool
    public var allowSensitiveCapability: Bool
    public var degraded: Bool
    public var suppressionReason: String?

    public init(allowProactive: Bool, cooldown: TimeInterval, maxConsecutiveProactive: Int,
                allowInterruptUser: Bool, allowSensitiveCapability: Bool, degraded: Bool = false,
                suppressionReason: String? = nil) {
        self.allowProactive = allowProactive
        self.cooldown = cooldown
        self.maxConsecutiveProactive = maxConsecutiveProactive
        self.allowInterruptUser = allowInterruptUser
        self.allowSensitiveCapability = allowSensitiveCapability
        self.degraded = degraded
        self.suppressionReason = suppressionReason
    }
}

public struct BehaviorPolicy: Sendable {
    public var mode: ProactiveMode

    /// DEFAULT mode is companion (doc §6.6).
    public init(mode: ProactiveMode = .companion) { self.mode = mode }

    public func decide(environment: EnvironmentContext) -> BehaviorModeDecision {
        var decision = Self.base(for: mode)
        if environment.isFullscreen || environment.inMeeting || environment.doNotDisturb {
            decision.allowProactive = false
            decision.allowInterruptUser = false
            decision.suppressionReason = "专注/全屏/勿扰，抑制主动行为"
        }
        if environment.lowBattery || environment.highSystemLoad {
            decision.degraded = true
            decision.cooldown *= 2
            decision.maxConsecutiveProactive = min(decision.maxConsecutiveProactive, 1)
        }
        return decision
    }

    private static func base(for mode: ProactiveMode) -> BehaviorModeDecision {
        switch mode {
        case .quiet:
            return BehaviorModeDecision(allowProactive: false, cooldown: 3600, maxConsecutiveProactive: 0,
                                        allowInterruptUser: false, allowSensitiveCapability: false,
                                        suppressionReason: "安静模式")
        case .companion:
            return BehaviorModeDecision(allowProactive: true, cooldown: 600, maxConsecutiveProactive: 2,
                                        allowInterruptUser: false, allowSensitiveCapability: false)
        case .active:
            return BehaviorModeDecision(allowProactive: true, cooldown: 300, maxConsecutiveProactive: 3,
                                        allowInterruptUser: false, allowSensitiveCapability: true)
        case .agentWorking:
            return BehaviorModeDecision(allowProactive: false, cooldown: 900, maxConsecutiveProactive: 1,
                                        allowInterruptUser: true, allowSensitiveCapability: true,
                                        suppressionReason: "Agent 执行中，不插入闲聊")
        }
    }

    /// Consult the existing deterministic engine, folding in this policy's environment-aware
    /// suppression. Never executes anything — only decides whether a candidate may surface.
    public func gateProactive(urgency: Double, companionshipValue: Double, privacyRisk: Double,
                              environment: EnvironmentContext, cooldownActive: Bool) -> ProactiveDecision {
        let decision = decide(environment: environment)
        let inputs = ProactiveInputs(
            urgency: urgency,
            companionshipValue: companionshipValue,
            interruptionCost: 0.2,
            privacyRisk: privacyRisk,
            userBusy: environment.userBusy,
            mode: mode,
            cooldownActive: cooldownActive || !decision.allowProactive)
        return ProactivePolicyEngine.decide(inputs)
    }
}
