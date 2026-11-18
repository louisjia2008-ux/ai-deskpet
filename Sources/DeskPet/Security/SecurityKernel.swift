import Foundation
import AICore

/// App-side security kernel: the single path from "the brain wants to do X" to "X actually runs".
/// Holds the CapabilityBroker (policy/tokens/audit) and drives the isolated ToolRunner. No model or
/// agent can execute anything except through here (decision 7/8, C2). UI approval for P1+ arrives in P3.
@MainActor
final class SecurityKernel {
    private var broker: CapabilityBroker
    private let runner: ToolRunnerService
    /// Approval callback for P1+ (wired to UI in P3). Default denies non-auto approvals.
    var approve: (_ capabilityID: String, _ level: ApprovalLevel, _ combos: [String]) async -> Bool = { _, level, _ in
        level == .auto
    }

    init(tier: DistributionTier, runner: ToolRunnerService = ToolRunnerService()) {
        self.broker = CapabilityBroker(tier: tier)
        self.runner = runner
    }

    var auditEntries: [AuditEntry] { broker.audit.entries }

    /// Request → (auto or user approval) → mint short-lived token → isolated execution → revoke.
    func run(capabilityID: String, params: [String: String] = [:], reason: String,
             taskID: UUID? = nil) async -> ToolResult {
        let req = GrantRequest(capabilityID: capabilityID, reason: reason, taskID: taskID, duration: .onceImmediate)
        let decision = broker.request(req)
        switch decision {
        case .denied(let r):
            return ToolResult(id: req.capabilityID, ok: false, output: "", error: r)
        case .needsApproval(let level, let combos):
            guard await approve(capabilityID, level, combos) else {
                return ToolResult(id: req.capabilityID, ok: false, output: "", error: "用户未批准（\(level.rawValue)）")
            }
            guard let grant = broker.approve(req) else {
                return ToolResult(id: req.capabilityID, ok: false, output: "", error: "授权失败")
            }
            let inv = ToolInvocation(capabilityID: capabilityID, token: grant.token, params: params)
            let result = await runner.invoke(inv)
            broker.revoke(token: grant.token)   // onceImmediate → drop after use
            return result
        case .granted(let grant):
            let inv = ToolInvocation(capabilityID: capabilityID, token: grant.token, params: params)
            return await runner.invoke(inv)
        }
    }
}
