import Foundation
import PetAgentRuntime

/// P19.1 — Build a compact, truthful one-line preview of a tool's actual outcome.
///
/// Design rules (per P19.1 §5):
/// 1. **Truthful**: previews only come from the real, runtime-surfaced
///    `AgentToolObservation.userSafeSummary` (which is itself sanitized through
///    `AgentPrivacyRedactor.safeSummary`). We never fabricate counts, ranges, or
///    summaries from weak proxies such as activity-event count or tool lifecycle
///    count.
/// 2. **Conservative fallback**: when the real summary is empty, contains chain-of-thought
///    markers, or fails sanitization, this returns `nil` so the caller can render the
///    safe generic title ("已完成日历查询") instead of inventing a fact.
/// 3. **Reuse existing sanitizers**: the value is run through `AgentPrivacyRedactor.safeText`
///    (which already strips bearer tokens, sk-/ak-/pk-/rk- secrets, opaque token strings,
///    `/Users/...` and `/Volumes/...` paths). We do NOT introduce a competing weaker
///    sanitizer.
@MainActor
public enum ToolOutputPreviewBuilder {

    /// Build a one-line preview for the given tool.
    ///
    /// - Parameters:
    ///   - toolID: capability/tool identifier (e.g. `list_today_calendar_events`)
    ///   - rawUserSafeSummary: the unsanitized but runtime-supplied user-safe summary
    ///     from `AgentToolObservation.userSafeSummary`. The runner has already passed
    ///     it through `AgentPrivacyRedactor.safeSummary` once; we pass it through
    ///     `AgentPrivacyRedactor.safeText` again as defense in depth.
    /// - Returns: a single-line preview, or `nil` when no trustworthy value is available.
    public static func preview(toolID: String, rawUserSafeSummary: String?) -> String? {
        guard let raw = rawUserSafeSummary else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // Defense-in-depth sanitization: the runner already redacts secrets, but
        // we re-run safeText so a future code path that bypasses the runner cannot
        // leak tokens into the UI. See AgentPrivacyRedactor.safeText for the regexes.
        let safe = AgentPrivacyRedactor.safeText(trimmed, maxLength: 80).text
        guard !safe.isEmpty else { return nil }

        // Reject chain-of-thought-like text. AgentPrivacyRedactor.safeSummary already
        // does this for the title path; the preview path sees the raw detail so we
        // re-check.
        let lowered = safe.lowercased()
        let forbidden = ["reasoning", "thinking", "analysis", "推理", "思维链", "分析用户"]
        if forbidden.contains(where: { lowered.contains($0) || safe.contains($0) }) {
            return nil
        }

        return safe
    }
}