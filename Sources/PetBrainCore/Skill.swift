import Foundation
import AICore

/// Hermes-style growth (doc §10.6 / §22 v0.6). Experience NEVER auto-becomes an executable skill:
/// it must pass extraction → static check → sandbox test → permission diff → user approval → install.
/// Pure & testable; the actual sandbox executor is an isolated runner (BLOCKED on later phases).

public struct SkillProposal: Sendable, Equatable {
    public var name: String
    public var summary: String
    public var steps: [String]
    public var requiredCapabilities: [String]
    public init(name: String, summary: String, steps: [String], requiredCapabilities: [String]) {
        self.name = name; self.summary = summary; self.steps = steps; self.requiredCapabilities = requiredCapabilities
    }
}

public struct StaticCheckResult: Sendable, Equatable {
    public var passed: Bool
    public var issues: [String]
}

public enum SkillPipeline {
    /// Static safety gate: capabilities must be known, none P4, no arbitrary shell / keychain / push.
    public static func staticCheck(_ p: SkillProposal) -> StaticCheckResult {
        var issues: [String] = []
        if p.name.trimmingCharacters(in: .whitespaces).isEmpty { issues.append("空技能名") }
        if p.steps.isEmpty { issues.append("无步骤") }
        for capID in p.requiredCapabilities {
            guard let cap = CapabilityCatalog.lookup(capID) else { issues.append("未知能力：\(capID)"); continue }
            if cap.risk >= .p4 { issues.append("技能不得申请高危能力：\(capID)") }
            if ["shell.arbitrary", "keychain.generalRead", "git.push"].contains(capID) {
                issues.append("技能禁用能力：\(capID)")
            }
        }
        return StaticCheckResult(passed: issues.isEmpty, issues: issues)
    }

    /// New capabilities this skill needs beyond what's already granted (shown to the user, §10.6).
    public static func permissionDiff(_ p: SkillProposal, alreadyGranted: [String]) -> [String] {
        p.requiredCapabilities.filter { !alreadyGranted.contains($0) }.sorted()
    }
}

public struct InstalledSkill: Sendable, Equatable {
    public var name: String
    public var version: Int
    public var capabilities: [String]
}

/// Holds installed skills + version history for rollback (doc §10.6 — Skill 版本和回滚).
public struct SkillRegistry: Sendable {
    public private(set) var installed: [String: InstalledSkill] = [:]
    private var history: [String: [InstalledSkill]] = [:]
    public init() {}

    public enum InstallResult: Sendable, Equatable {
        case installed(version: Int)
        case rejected(reason: String)
    }

    /// Install ONLY if static + sandbox + explicit approval all pass — never auto (doc §16.1).
    public mutating func install(_ p: SkillProposal, sandboxPassed: Bool, approved: Bool) -> InstallResult {
        let check = SkillPipeline.staticCheck(p)
        guard check.passed else { return .rejected(reason: "静态检查失败：\(check.issues.joined(separator: "; "))") }
        guard sandboxPassed else { return .rejected(reason: "沙箱测试未通过") }
        guard approved else { return .rejected(reason: "未经用户批准") }

        let prevVersion = installed[p.name]?.version ?? 0
        if let prev = installed[p.name] { history[p.name, default: []].append(prev) }
        let skill = InstalledSkill(name: p.name, version: prevVersion + 1, capabilities: p.requiredCapabilities)
        installed[p.name] = skill
        return .installed(version: skill.version)
    }

    /// Roll back to the previous installed version (or uninstall if none).
    @discardableResult
    public mutating func rollback(_ name: String) -> Bool {
        guard installed[name] != nil else { return false }
        if var hist = history[name], let prev = hist.popLast() {
            installed[name] = prev; history[name] = hist
        } else {
            installed[name] = nil
        }
        return true
    }
}
