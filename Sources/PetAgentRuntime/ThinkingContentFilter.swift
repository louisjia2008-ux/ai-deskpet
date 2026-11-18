import Foundation

/// P15 — Thinking / Reasoning Leak Filter.
///
/// Strips provider-emitted thinking content (chain-of-thought, hidden
/// reasoning, structured `reasoning` fields, raw `<think>` tags) from
/// text before it reaches the user-visible assistant message stream.
///
/// This filter is intentionally lightweight and conservative:
///   - Strips complete `<think>…</think>` blocks (may be multi-line).
///   - Strips incomplete `<think>…` opening markers.
///   - Strips content inside `<tool_call>`…`</tool_call>` (provider tool calls
///     belong on the runtime, not in chat).
///   - Strips `<reasoning>…</reasoning>` blocks.
///   - Strips `**reasoning**:` style markers.
///   - Strips lines that are *only* reasoning tags.
///
/// What this filter does NOT do (intentionally):
///   - It does not inspect provider-specific structured `reasoning` channels
///     — those must be routed into internal telemetry or dropped at the
///     provider adapter boundary; this filter only sees raw text deltas.
///   - It does not translate or summarize — it only removes.
public enum ThinkingContentFilter {

    public struct FilterResult: Equatable, Sendable {
        public let visible: String
        public let strippedThinkingBytes: Int
        public let strippedThinkingBlocks: Int

        public var didStrip: Bool { strippedThinkingBytes > 0 || strippedThinkingBlocks > 0 }
    }

    /// Apply the filter to a single text delta.
    public static func filter(_ raw: String) -> FilterResult {
        var strippedBytes = 0
        var strippedBlocks = 0

        var working = raw

        // 1) Complete <think>...</think> blocks (greedy, multiline).
        let thinkRegex = try! NSRegularExpression(
            pattern: #"(?is)<think\b[^>]*>.*?</think>"#,
            options: [])
        let thinkMatches = thinkRegex.matches(in: working, options: [], range: NSRange(working.startIndex..., in: working))
        for m in thinkMatches {
            if let r = Range(m.range, in: working) {
                strippedBytes += working[r].utf8.count
            }
            strippedBlocks += 1
        }
        working = thinkRegex.stringByReplacingMatches(in: working, options: [], range: NSRange(working.startIndex..., in: working), withTemplate: "")

        // 2) Unclosed <think>... (provider may stream mid-block).
        let openThink = working.range(of: #"(?is)<think\b[^>]*>"#, options: .regularExpression)
        if let openRange = openThink {
            strippedBytes += working[openRange.lowerBound...].utf8.count
            working = String(working[..<openRange.lowerBound])
        }

        // 3) Complete <reasoning>...</reasoning> blocks.
        let reasoningRegex = try! NSRegularExpression(
            pattern: #"(?is)<reasoning\b[^>]*>.*?</reasoning>"#,
            options: [])
        let reasoningMatches = reasoningRegex.matches(in: working, options: [], range: NSRange(working.startIndex..., in: working))
        for m in reasoningMatches {
            if let r = Range(m.range, in: working) {
                strippedBytes += working[r].utf8.count
            }
            strippedBlocks += 1
        }
        working = reasoningRegex.stringByReplacingMatches(in: working, options: [], range: NSRange(working.startIndex..., in: working), withTemplate: "")

        // 4) Unclosed <reasoning>.
        let openReasoning = working.range(of: #"(?is)<reasoning\b[^>]*>"#, options: .regularExpression)
        if let openRange = openReasoning {
            strippedBytes += working[openRange.lowerBound...].utf8.count
            working = String(working[..<openRange.lowerBound])
        }

        // 5) <tool_call>...</tool_call> blocks — tool calls must not leak into chat.
        let toolCallRegex = try! NSRegularExpression(
            pattern: #"(?is)<tool_call>.*?</tool_call>"#,
            options: [])
        let toolCallMatches = toolCallRegex.matches(in: working, options: [], range: NSRange(working.startIndex..., in: working))
        for m in toolCallMatches {
            if let r = Range(m.range, in: working) {
                strippedBytes += working[r].utf8.count
            }
            strippedBlocks += 1
        }
        working = toolCallRegex.stringByReplacingMatches(in: working, options: [], range: NSRange(working.startIndex..., in: working), withTemplate: "")

        // 6) Mid-stream leftover tags that may have leaked through prior filters
        //    due to the streaming chunk boundary cutting tags in half.
        let leftoverPatterns = [
            "</think>", "</reasoning>", "</think>", "</reasoning>",
            "<think>", "<reasoning>",
            "<tool_call>", "</tool_call>"
        ]
        for p in leftoverPatterns {
            if let r = working.range(of: p) {
                strippedBytes += working[r].utf8.count
                working.replaceSubrange(r, with: "")
            }
        }

        // 7) Collapse 3+ consecutive newlines that may have resulted from removed blocks.
        while working.contains("\n\n\n") {
            working = working.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        return FilterResult(
            visible: working,
            strippedThinkingBytes: strippedBytes,
            strippedThinkingBlocks: strippedBlocks
        )
    }

    /// Detect (without stripping) whether a delta contains thinking content.
    /// Used by activity projection to trigger the `.thinking` phase.
    public static func containsThinking(_ raw: String) -> Bool {
        if raw.range(of: #"<think\b"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if raw.range(of: #"<reasoning\b"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if raw.range(of: #"<tool_call>\b"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        return false
    }
}
