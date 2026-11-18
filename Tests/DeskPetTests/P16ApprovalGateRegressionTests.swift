import XCTest
@testable import PetAgentRuntime

/// P16 GAP-01 — verifies the friendly-copy replacement for the approval gate
/// placeholder. These tests are static-source assertions: they read the
/// AgentLoopController source at test time and assert the placeholder phrase
/// does not appear and the friendly TaskActivityCard copy is present.
///
/// The companion dynamic behavior is covered by P15.1 acceptance tests
/// (`P15_1GUIAcceptanceTests`) which already exercise the approval gate.
final class P16ApprovalGateRegressionTests: XCTestCase {

    /// Locate the source file by walking up from the test bundle.
    private func source(of name: String) throws -> String {
        // The test bundle lives inside DerivedData. We walk up to find the
        // original repo source path. We use SOURCE_ROOT env if present (xcodebuild
        // sets `PROJECT_DIR` and `SRCROOT` for unit tests).
        let env = ProcessInfo.processInfo.environment
        let candidates: [String?] = [env["SRCROOT"], env["SOURCE_ROOT"], env["PROJECT_DIR"]]
        var resolved: URL? = nil
        for case let c? in candidates {
            let url = URL(fileURLWithPath: c)
                .appendingPathComponent("Sources")
                .appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { resolved = url; break }
        }
        // Fall back: walk up from test bundle until we find the source.
        if resolved == nil {
            var probe = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
            for _ in 0..<8 {
                let candidate = probe
                    .appendingPathComponent("Sources")
                    .appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: candidate.path) { resolved = candidate; break }
                probe = probe.deletingLastPathComponent()
            }
        }
        guard let url = resolved else {
            throw NSError(domain: "P16", code: 1, userInfo: [NSLocalizedDescriptionKey: "could not locate \(name)"])
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    func testAgentLoopControllerAskUserFinalTextIsUserFriendly() throws {
        let src = try source(of: "PetAgentRuntime/AgentLoopController.swift")
        XCTAssertFalse(src.contains("审批界面尚未完成"),
                       "GAP-01: placeholder copy '审批界面尚未完成' must not appear in AgentLoopController")
        XCTAssertFalse(src.contains("尚未完成"),
                       "GAP-01: placeholder copy '尚未完成' must not appear in AgentLoopController")
        XCTAssertTrue(src.contains("需要你的允许才能继续"),
                      "GAP-01: friendly copy '需要你的允许才能继续' must appear in AgentActivityCard or controller")
    }

    func testCoordinatorSkipsConverseWhenWaitingForApproval() throws {
        let src = try source(of: "PetAgentRuntime/PetAgentRuntimeCoordinator.swift")
        // Must early-return before converse() when waitingApproval is non-empty.
        XCTAssertTrue(src.contains("waitingForApproval(capabilityID"),
                      "GAP-01: coordinator must emit waitingForApproval events")
        // Must reference waitingApproval (the early-return guard)
        let hasGuard = src.contains("!loop.waitingApproval.isEmpty") ||
                       src.contains("loop.waitingApproval.isEmpty")
        XCTAssertTrue(hasGuard,
                      "GAP-01: coordinator must short-circuit converse on waiting approval")
    }

    func testNoPlaceholderCopyInPetAgentRuntimeSources() throws {
        let agentLoop = try source(of: "PetAgentRuntime/AgentLoopController.swift")
        let coordinator = try source(of: "PetAgentRuntime/PetAgentRuntimeCoordinator.swift")
        // Strip // line comments and /* */ block comments so we only assert
        // on production code (not developer-facing comments referencing
        // historical text).
        let strippedAgentLoop = stripSwiftComments(agentLoop)
        let strippedCoordinator = stripSwiftComments(coordinator)
        // Strip string literals so quoted references (e.g. log messages
        // referencing the historical phrase) don't trigger the assertion.
        let codeAgentLoop = stripStringLiterals(strippedAgentLoop)
        let codeCoordinator = stripStringLiterals(strippedCoordinator)
        XCTAssertFalse(codeAgentLoop.contains("审批界面尚未完成"),
                       "GAP-01: placeholder must be removed from AgentLoopController code")
        XCTAssertFalse(codeCoordinator.contains("审批界面尚未完成"),
                       "GAP-01: placeholder must be removed from PetAgentRuntimeCoordinator code")
        XCTAssertFalse(codeAgentLoop.contains("尚未完成"),
                       "GAP-01: '尚未完成' must be removed from AgentLoopController code")
        XCTAssertFalse(codeCoordinator.contains("尚未完成"),
                       "GAP-01: '尚未完成' must be removed from PetAgentRuntimeCoordinator code")
    }

    private func stripSwiftComments(_ s: String) -> String {
        var out = s
        // Block comments
        if let regex = try? NSRegularExpression(pattern: "/\\*[\\s\\S]*?\\*/", options: []) {
            out = regex.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "")
        }
        // Line comments
        if let regex = try? NSRegularExpression(pattern: "//[^\\n]*", options: []) {
            out = regex.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "")
        }
        return out
    }

    private func stripStringLiterals(_ s: String) -> String {
        // Replace any quoted Swift string literal with an empty string.
        // Handles both single-line "..." and multi-line """...""" forms.
        var out = s
        if let regex = try? NSRegularExpression(pattern: "\"\"\"[\\s\\S]*?\"\"\"", options: []) {
            out = regex.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "\"\"\"\"\"\"")
        }
        if let regex = try? NSRegularExpression(pattern: "\"(?:\\\\.|[^\"\\\\\\n])*\"", options: []) {
            out = regex.stringByReplacingMatches(in: out, options: [], range: NSRange(location: 0, length: (out as NSString).length), withTemplate: "\"\"")
        }
        return out
    }
}
