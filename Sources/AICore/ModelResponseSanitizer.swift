import Foundation
import os.lock

public struct SanitizedModelResponse: Equatable, Sendable {
    public var visibleText: String
    public var reasoningText: String?
    public var hadReasoning: Bool

    public init(visibleText: String, reasoningText: String?, hadReasoning: Bool) {
        self.visibleText = visibleText
        self.reasoningText = reasoningText
        self.hadReasoning = hadReasoning
    }
}

public enum ModelResponseSanitizer {
    public static func sanitize(content: String?, reasoningContent: String? = nil) -> SanitizedModelResponse {
        let rawReasoning = reasoningContent?.trimmingCharacters(in: .whitespacesAndNewlines)
        var visible = content ?? ""
        var extractedReasoning: [String] = []

        for tag in ["think", "thinking"] {
            let result = removeTaggedBlocks(named: tag, from: visible)
            visible = result.visible
            extractedReasoning.append(contentsOf: result.reasoning)
            let dangling = removeDanglingPrefix(throughClosingTag: tag, from: visible)
            visible = dangling.visible
            if let reasoning = dangling.reasoning {
                extractedReasoning.append(reasoning)
            }
            let open = removeDanglingOpenTag(named: tag, from: visible)
            visible = open.visible
            if let reasoning = open.reasoning {
                extractedReasoning.append(reasoning)
            }
        }

        let prefixResult = removeReasoningPrefix(from: visible)
        visible = prefixResult.visible
        if let reasoning = prefixResult.reasoning {
            extractedReasoning.append(reasoning)
        }

        visible = visible.trimmingCharacters(in: .whitespacesAndNewlines)
        let reasoningParts = ([rawReasoning].compactMap { $0 } + extractedReasoning)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return SanitizedModelResponse(
            visibleText: visible,
            reasoningText: reasoningParts.isEmpty ? nil : reasoningParts.joined(separator: "\n\n"),
            hadReasoning: !reasoningParts.isEmpty)
    }

    private static func removeTaggedBlocks(named tag: String, from input: String) -> (visible: String, reasoning: [String]) {
        let pattern = "(?is)<\\s*\(tag)\\s*>(.*?)<\\s*/\\s*\(tag)\\s*>"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return (input, [])
        }
        let nsRange = NSRange(input.startIndex..<input.endIndex, in: input)
        var reasoning: [String] = []
        for match in regex.matches(in: input, range: nsRange).reversed() {
            if match.numberOfRanges > 1,
               let range = Range(match.range(at: 1), in: input) {
                reasoning.append(String(input[range]))
            }
        }
        let visible = regex.stringByReplacingMatches(in: input, range: nsRange, withTemplate: "")
        return (visible, reasoning.reversed())
    }

    private static func removeDanglingPrefix(throughClosingTag tag: String,
                                             from input: String) -> (visible: String, reasoning: String?) {
        let pattern = "(?is)^\\s*(.*?)<\\s*/\\s*\(tag)\\s*>"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return (input, nil)
        }
        let nsRange = NSRange(input.startIndex..<input.endIndex, in: input)
        guard let match = regex.firstMatch(in: input, range: nsRange),
              let fullRange = Range(match.range(at: 0), in: input) else {
            return (input, nil)
        }
        let reasoning: String?
        if match.numberOfRanges > 1, let reasoningRange = Range(match.range(at: 1), in: input) {
            reasoning = String(input[reasoningRange])
        } else {
            reasoning = nil
        }
        return (String(input[fullRange.upperBound...]), reasoning)
    }

    private static func removeDanglingOpenTag(named tag: String,
                                              from input: String) -> (visible: String, reasoning: String?) {
        let pattern = "(?is)<\\s*\(tag)\\s*>"
        guard let regex = try? NSRegularExpression(pattern: pattern) else {
            return (input, nil)
        }
        let nsRange = NSRange(input.startIndex..<input.endIndex, in: input)
        guard let match = regex.firstMatch(in: input, range: nsRange),
              let fullRange = Range(match.range(at: 0), in: input) else {
            return (input, nil)
        }
        let before = String(input[..<fullRange.lowerBound])
        let reasoning = String(input[fullRange.upperBound...])
        return (before, reasoning)
    }

    private static func removeReasoningPrefix(from input: String) -> (visible: String, reasoning: String?) {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowered = trimmed.lowercased()
        let prefixes = [
            "reasoning:",
            "reasoning_content:",
            "thinking:",
            "thought:",
            "internal reasoning:",
            "内部推理：",
            "推理：",
            "思考："
        ]
        guard prefixes.contains(where: { lowered.hasPrefix($0) || trimmed.hasPrefix($0) }) else {
            return (input, nil)
        }
        let separators = ["\n\n", "\r\n\r\n", "最终回答：", "最终答案：", "final answer:"]
        for separator in separators {
            if let range = trimmed.range(of: separator, options: separator == "final answer:" ? .caseInsensitive : []) {
                let reasoning = String(trimmed[..<range.lowerBound])
                var visible = String(trimmed[range.upperBound...])
                if separator.hasPrefix("\n") {
                    visible = String(trimmed[range.upperBound...])
                }
                return (visible, reasoning)
            }
        }
        return ("", trimmed)
    }
}

// P18.3 — U-14: Lock-protected single-field sanitizer. The only mutable
// state is `state: State` (an enum with associated Strings — value semantic);
// `ingest` and `finish` both bracket their work with the same unfair lock,
// and the `process(character:visible:reasoning:)` helper is reachable only
// from inside a locked section. The lock therefore covers the full read-
// modify-write window of the sole mutable field — no compound invariant
// to defend.
//
// P22 — replaced `NSLock` + `private var` with `OSAllocatedUnfairLock<State>`
// so the class can declare unconditional `Sendable` conformance instead of
// `@unchecked Sendable`. The unfair lock is itself `Sendable`.
//
// If a second mutable field is ever added, the new field MUST be read and
// written under the same lock (extend `state.withLockUnchecked { ... }`
// coverage) OR a separate lock with a documented invariant contract.
public final class StreamingModelResponseSanitizer: Sendable {
    private enum State {
        case visible
        case maybeOpeningTag(String)
        case hidden(String)
    }

    private let state = OSAllocatedUnfairLock<State>(initialState: .visible)

    public init() {}

    public func ingest(contentDelta: String?, reasoningDelta: String? = nil) -> SanitizedModelResponse {
        state.withLockUnchecked { current in
            var visible = ""
            var reasoning: [String] = []
            if let reasoningDelta, !reasoningDelta.isEmpty {
                reasoning.append(reasoningDelta)
            }
            for character in contentDelta ?? "" {
                process(character, visible: &visible, reasoning: &reasoning, state: &current)
            }
            return SanitizedModelResponse(
                visibleText: visible,
                reasoningText: reasoning.isEmpty ? nil : reasoning.joined(),
                hadReasoning: !reasoning.isEmpty)
        }
    }

    public func finish() -> SanitizedModelResponse {
        state.withLockUnchecked { current in
            var visible = ""
            var reasoning: String?
            switch current {
            case .visible:
                break
            case .maybeOpeningTag(let buffered):
                visible = buffered
            case .hidden(let hidden):
                reasoning = hidden.isEmpty ? nil : hidden
            }
            current = .visible
            return SanitizedModelResponse(visibleText: visible,
                                          reasoningText: reasoning,
                                          hadReasoning: reasoning != nil)
        }
    }

    private func process(_ character: Character,
                         visible: inout String,
                         reasoning: inout [String],
                         state: inout State) {
        switch state {
        case .visible:
            if character == "<" {
                state = .maybeOpeningTag("<")
            } else {
                visible.append(character)
            }
        case .maybeOpeningTag(var buffered):
            buffered.append(character)
            if isCompleteOpeningTag(buffered) {
                state = .hidden("")
            } else if isOpeningTagPrefix(buffered) {
                state = .maybeOpeningTag(buffered)
            } else {
                visible += buffered
                state = .visible
            }
        case .hidden(var hidden):
            hidden.append(character)
            if let withoutClosingTag = hiddenWithoutCompletedClosingTag(hidden) {
                if !withoutClosingTag.isEmpty {
                    reasoning.append(withoutClosingTag)
                }
                state = .visible
            } else {
                state = .hidden(hidden)
            }
        }
    }

    private func isOpeningTagPrefix(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return ["<think>", "<thinking>"].contains { $0.hasPrefix(lowered) }
    }

    private func isCompleteOpeningTag(_ value: String) -> Bool {
        let lowered = value.lowercased()
        return lowered == "<think>" || lowered == "<thinking>"
    }

    private func hiddenWithoutCompletedClosingTag(_ value: String) -> String? {
        let lowered = value.lowercased()
        for tag in ["</think>", "</thinking>"] where lowered.hasSuffix(tag) {
            return String(value.dropLast(tag.count))
        }
        return nil
    }
}
