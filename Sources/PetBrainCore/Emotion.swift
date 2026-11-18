import Foundation
import AICore

/// Short-term emotion (doc §6.2): fast-changing, time-decaying. Six dimensions in 0…1 (0.5 neutral).
/// `EmotionState` is deliberately immutable from outside — only `EmotionReducer` can produce a new
/// state (via the module-internal initializer), so a model's `EmotionProposal` can never bypass the
/// reducer (decision 3, §6.2).
public enum EmotionDimension: String, Sendable, Codable, CaseIterable, Equatable {
    case valence, arousal, energy, concern, playfulness, focus
}

public enum EmotionTrigger: String, Sendable, Codable, Equatable {
    case userMessage, taskSuccess, taskFailure, interaction, idle, learning, encouragement
}

public struct EmotionProposal: Sendable, Codable, Equatable {
    public var deltas: [EmotionDimension: Double]
    public var trigger: EmotionTrigger
    public init(deltas: [EmotionDimension: Double], trigger: EmotionTrigger) {
        self.deltas = deltas; self.trigger = trigger
    }
}

public struct EmotionState: Sendable, Codable, Equatable {
    private var v: [EmotionDimension: Double]

    /// Module-internal: only PetBrainCore (i.e. the reducer) can build an arbitrary state.
    init(raw: [EmotionDimension: Double]) {
        var clamped: [EmotionDimension: Double] = [:]
        for d in EmotionDimension.allCases { clamped[d] = Self.clamp(raw[d] ?? 0.5) }
        self.v = clamped
    }

    public static let neutral = EmotionState(raw: [:])
    public func value(_ d: EmotionDimension) -> Double { v[d] ?? 0.5 }

    static func clamp(_ x: Double) -> Double { min(1, max(0, x)) }

    /// Resolved display emotion for the renderer/pet (doc §6.2 → 表情). Priority-ordered.
    public var dominant: PetEmotion {
        if value(.energy) < 0.32 { return .sleepy }
        if value(.concern) > 0.62 { return .sad }
        if value(.valence) > 0.6 && value(.arousal) > 0.6 { return .excited }
        if value(.playfulness) > 0.62 { return .happy }
        if value(.focus) > 0.6 && value(.arousal) < 0.5 { return .thinking }
        if value(.valence) > 0.58 { return .happy }
        if value(.valence) < 0.4 && value(.arousal) < 0.4 { return .shy }
        return .neutral
    }
}

/// The ONLY mutator of EmotionState (decision 3). Enforces single-step cap + time decay toward
/// neutral. Pure and deterministic given timestamps → fully unit-testable.
public struct EmotionReducer: Sendable {
    public var maxDeltaPerApply: Double
    public var decayPerSecond: Double

    public init(maxDeltaPerApply: Double = 0.2, decayPerSecond: Double = 0.02) {
        self.maxDeltaPerApply = maxDeltaPerApply
        self.decayPerSecond = decayPerSecond
    }

    /// Decay every dimension toward 0.5 by elapsed seconds (no overshoot).
    public func decayed(_ state: EmotionState, seconds: Double) -> EmotionState {
        guard seconds > 0 else { return state }
        let step = decayPerSecond * seconds
        var raw: [EmotionDimension: Double] = [:]
        for d in EmotionDimension.allCases {
            let cur = state.value(d)
            if cur > 0.5 { raw[d] = max(0.5, cur - step) }
            else if cur < 0.5 { raw[d] = min(0.5, cur + step) }
            else { raw[d] = 0.5 }
        }
        return EmotionState(raw: raw)
    }

    /// Apply a model's proposal: first decay for elapsed time, then add per-dimension deltas each
    /// clamped to ±maxDeltaPerApply (so a single proposal can't swing emotion wildly, §6.2).
    public func apply(_ proposal: EmotionProposal, to state: EmotionState,
                      elapsed seconds: Double) -> EmotionState {
        let base = decayed(state, seconds: seconds)
        var raw: [EmotionDimension: Double] = [:]
        for d in EmotionDimension.allCases {
            let delta = max(-maxDeltaPerApply, min(maxDeltaPerApply, proposal.deltas[d] ?? 0))
            raw[d] = base.value(d) + delta
        }
        return EmotionState(raw: raw)
    }
}
