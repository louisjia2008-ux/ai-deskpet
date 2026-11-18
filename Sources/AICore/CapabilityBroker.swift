import Foundation

/// Combination-risk evaluation (doc 03 §5): some capability *pairs* are dangerous together even
/// when each is individually granted (e.g. read + upload = exfiltration). Pure & testable.
public enum CombinationRisk {
    /// (heldPredicate, addingPredicate) → human-readable risk name.
    private static let rules: [(held: String, adding: String, name: String)] = [
        ("filesystem", "network.upload", "数据泄露：本地文件 + 网络上传"),
        ("screen", "network", "屏幕内容外传：截图/OCR + 网络"),
        ("contacts.read", "mail.send", "冒充用户：联系人 + 发邮件"),
        ("accessibility", "browser.control", "账户操作：辅助功能 + 浏览器控制"),
        ("accessibility", "application", "账户操作：辅助功能 + 应用控制"),
    ]
    public static func triggered(held: [String], adding: String) -> [String] {
        let combined = held + [adding]
        var out: [String] = []
        for r in rules {
            let hasHeld = combined.contains { $0.contains(r.held) }
            let hasAdding = combined.contains { $0.contains(r.adding) }
            let addingRelevant = adding.contains(r.held) || adding.contains(r.adding)
            if hasHeld && hasAdding && addingRelevant { out.append(r.name) }
        }
        return Array(Set(out)).sorted()
    }
}

public enum ApprovalLevel: String, Sendable, Equatable { case auto, single, perUse }

/// The user's answer to an approval prompt (P3). `allowSession` trusts this capability for the rest
/// of the session so the same effect isn't re-prompted.
public enum ApprovalDecision: Sendable, Equatable { case allowOnce, allowSession, deny }

public enum BrokerDecision: Sendable, Equatable {
    case granted(CapabilityGrant)
    case denied(reason: String)
    case needsApproval(level: ApprovalLevel, combinationRisks: [String])
}

/// Pure decision logic (no state) — what a request *should* result in, given the tier and currently
/// held capabilities. The stateful broker calls this then records the outcome.
public enum BrokerPolicy {
    public static func evaluate(_ request: GrantRequest, tier: DistributionTier,
                                heldCapabilityIDs: [String]) -> BrokerDecision {
        guard let cap = CapabilityCatalog.lookup(request.capabilityID) else {
            return .denied(reason: "未知能力：\(request.capabilityID)")
        }
        if tier.isPermanentlyDenied(cap) {
            return .denied(reason: "\(cap.id) 在当前分发渠道（\(tier.rawValue)，上限 \(tier.ceiling.label)）永久禁用")
        }
        let combos = CombinationRisk.triggered(held: heldCapabilityIDs, adding: cap.id)
        if !combos.isEmpty { return .needsApproval(level: .perUse, combinationRisks: combos) }
        switch cap.risk {
        case .p0: return .needsApproval(level: .auto, combinationRisks: [])
        case .p1, .p2: return .needsApproval(level: .single, combinationRisks: [])
        case .p3, .p4: return .needsApproval(level: .perUse, combinationRisks: [])
        }
    }
}

/// Append-only audit entry (doc 03 §6). Sensitive values must be redacted before logging.
public struct AuditEntry: Sendable, Codable, Equatable {
    public enum Action: String, Sendable, Codable {
        case requested, granted, denied, tokenIssued, revoked, executed, executionDenied
    }
    public var timestamp: Date
    public var action: Action
    public var capabilityID: String
    public var taskID: UUID?
    public var detail: String      // already redacted
}

public struct AuditLog: Sendable, Codable, Equatable {
    public private(set) var entries: [AuditEntry] = []
    public init() {}
    public mutating func append(_ e: AuditEntry) { entries.append(e) }   // append-only
    public func forTask(_ id: UUID) -> [AuditEntry] { entries.filter { $0.taskID == id } }

    /// Redact obvious secrets/PII from a free-text detail before it is logged (doc 03 §6/§16.3).
    public static func redact(_ s: String) -> String {
        var out = s
        // P18.4 — AICO-005: the previous implementation included the SHORT
        // standalone tokens "api" and "key" in the substring-gate list.
        // Both false-positive on common phrases: "api" matches inside
        // "rapid" (a-p-i), "key" matches inside "I lost my key", etc.
        // The fix mirrors `ProviderModels.SecretMasking.redact` and uses
        // structured `key=value` regex matches so that ONLY the captured
        // value is replaced (preserving prose context). Long-token
        // substring gates remain for fail-safe detection of prose that
        // contains sensitive terminology without a clean key=value form.
        let valuePatterns: [(String, String)] = [
            (#"(?i)\b(api[-_ ]?key|apikey)\b\s*[:=]\s*\S+"#, "$1 [redacted]"),
            (#"(?i)\b(access[-_ ]?token|auth[-_ ]?token|refresh[-_ ]?token)\b\s*[:=]\s*\S+"#, "$1 [redacted]"),
            (#"(?i)(authorization\s*:\s*bearer)\s+\S+"#, "$1 [redacted]"),
            (#"sk-[A-Za-z0-9_\-]{8,}"#, "sk-[redacted]"),
        ]
        for (pattern, template) in valuePatterns {
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let range = NSRange(out.startIndex..<out.endIndex, in: out)
            out = regex.stringByReplacingMatches(in: out, range: range, withTemplate: template)
        }
        // Long-token substring gates — fail-safe. Short tokens ("api", "key")
        // intentionally NOT included here; structured redactors above already
        // catch the structured cases.
        for gate in ["password", "密码", "token", "secret"] {
            if out.lowercased().contains(gate) { return "[redacted]" }
        }
        // collapse long alphanumerics that look like keys
        if out.range(of: "[A-Za-z0-9_-]{24,}", options: .regularExpression) != nil { out = "[redacted]" }
        return out
    }
}

/// Stateful Capability Broker — the single permission entry (decision 7). It only ISSUES tokens;
/// it never executes anything (ToolRunner does, out-of-process). Mutating struct so the owning
/// actor serializes access.
public struct CapabilityBroker: Sendable {
    public let tier: DistributionTier
    public private(set) var grants: [CapabilityToken: CapabilityGrant] = [:]
    public private(set) var audit = AuditLog()
    private var tokenSeq = 0

    public init(tier: DistributionTier) { self.tier = tier }

    public var heldCapabilityIDs: [String] { grants.values.map { $0.capability.id } }

    /// Step 1: evaluate a request (pure decision + audit the request).
    public mutating func request(_ req: GrantRequest, now: Date = Date()) -> BrokerDecision {
        audit.append(AuditEntry(timestamp: now, action: .requested, capabilityID: req.capabilityID,
                                taskID: req.taskID, detail: AuditLog.redact(req.reason)))
        let decision = BrokerPolicy.evaluate(req, tier: tier, heldCapabilityIDs: heldCapabilityIDs)
        if case .denied(let reason) = decision {
            audit.append(AuditEntry(timestamp: now, action: .denied, capabilityID: req.capabilityID,
                                    taskID: req.taskID, detail: reason))
        }
        return decision
    }

    /// Step 2: after approval (auto for P0, user for P1+), mint a short-lived token bound to the task.
    public mutating func approve(_ req: GrantRequest, now: Date = Date()) -> CapabilityGrant? {
        guard let cap = CapabilityCatalog.lookup(req.capabilityID), !tier.isPermanentlyDenied(cap) else { return nil }
        tokenSeq += 1
        let token = CapabilityToken(raw: Self.newTokenRaw(seq: tokenSeq),
                                    taskID: req.taskID, expiresAt: req.duration.expiry(from: now),
                                    capabilityID: cap.id)
        let grant = CapabilityGrant(capability: cap, scope: req.scope, duration: req.duration,
                                    token: token, taskID: req.taskID, grantedAt: now)
        grants[token] = grant
        audit.append(AuditEntry(timestamp: now, action: .granted, capabilityID: cap.id, taskID: req.taskID, detail: ""))
        audit.append(AuditEntry(timestamp: now, action: .tokenIssued, capabilityID: cap.id, taskID: req.taskID, detail: ""))
        return grant
    }

    /// Unpredictable 256-bit token (2x UUID, no dashes). The `seq` prefix is kept
    /// only for debuggability ordering — entropy comes from the random suffix.
    static func newTokenRaw(seq: Int) -> String {
        let a = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        let b = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        return "tok-\(seq)-\(a)\(b)"
    }

    /// Validate a token for a capability at execution time (called by ToolRunner gating).
    /// Enforces: grant exists (not revoked) + capability binding + task binding + expiry.
    /// `taskID` is optional for backward compatibility with callers that only know the
    /// capability; when supplied, a mismatch fails closed.
    public func validate(token: CapabilityToken, capabilityID: String, taskID: UUID? = nil, now: Date = Date()) -> Bool {
        guard let g = grants[token] else { return false }
        guard g.capability.id == capabilityID else { return false }
        // Token↔capability binding (defense in depth against cross-capability replay).
        if let bound = token.capabilityID, bound != capabilityID { return false }
        // Task binding: grant task must match both the token and the caller's task.
        if let callerTask = taskID, g.taskID != callerTask { return false }
        if token.taskID != g.taskID { return false }
        return now < token.expiresAt
    }

    public mutating func revoke(token: CapabilityToken, now: Date = Date()) {
        if let g = grants.removeValue(forKey: token) {
            audit.append(AuditEntry(timestamp: now, action: .revoked, capabilityID: g.capability.id,
                                    taskID: g.taskID, detail: ""))
        }
    }

    public mutating func revokeTask(_ taskID: UUID, now: Date = Date()) {
        for (tok, g) in grants where g.taskID == taskID { revoke(token: tok, now: now) }
    }
}
