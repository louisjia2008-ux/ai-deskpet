import AppKit
import Foundation
import XCTest

private let p11RepositoryRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .path

final class DeskPetP11GateBRealOllamaUITests: XCTestCase {
    private let fileManager = FileManager.default

    private var evidenceRoot: URL {
        if let path = ProcessInfo.processInfo.environment["P11_2_GATEB_EVIDENCE_DIR"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: "\(p11RepositoryRoot)/review/p11_2_repository_gui_unblock_20260811_022457/06_gate_b_gui", isDirectory: true)
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        // Live-gate: these tests need a running Ollama with qwen3.5:0.8b plus a
        // built app bundle. Skip (not fail) without explicit opt-in so plain
        // `xcodebuild test` stays green on machines without the model.
        // Mirrors Tests/DeskPetTests/P9BLocalDiscoveryLiveProbeTests.swift.
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DESKPET_P11_LIVE_OLLAMA"] == "1",
            "Set DESKPET_P11_LIVE_OLLAMA=1 to run live Ollama GUI probes.")
        try fileManager.createDirectory(at: evidenceRoot, withIntermediateDirectories: true)
        try fileManager.createDirectory(at: evidenceRoot.appendingPathComponent("logs", isDirectory: true), withIntermediateDirectories: true)
        try fileManager.createDirectory(at: evidenceRoot.appendingPathComponent("screenshots", isDirectory: true), withIntermediateDirectories: true)
    }

    @MainActor
    func testP11GateBRealOllamaPlainSequentialAndCancel() throws {
        let profileID = "P11GateBReal-\(Self.shortUUID())"
        let app = launch(profileID: profileID, reset: true)
        defer { terminate(app) }

        openChat(app)
        assertProviderReady(in: app, model: "qwen3.5:0.8b")
        addScreenshot("gui-1-launch-chat-ready", app: app)

        send("Reply with exactly: P11_GUI_PLAIN_OK", in: app)
        XCTAssertTrue(waitForText("P11_GUI_PLAIN_OK", in: app, timeout: 90), "plain Ollama response missing")
        assertNoReasoningLeak(profileID: profileID)
        assertNoPermanentSpinner(in: app)
        addScreenshot("gui-2-ollama-plain-chat", app: app)

        send("Reply with exactly: P11_GUI_SECOND_OK", in: app)
        XCTAssertTrue(waitForText("P11_GUI_SECOND_OK", in: app, timeout: 90), "second Ollama response missing")
        assertNoReasoningLeak(profileID: profileID)
        assertNoPermanentSpinner(in: app)
        addScreenshot("gui-3-ollama-second-chat", app: app)

        send("Write a long answer in at least 1200 Chinese characters. Start with P11_CANCEL_STREAM and continue until stopped.", in: app)
        XCTAssertTrue(waitForText("P11_CANCEL_STREAM", in: app, timeout: 45), "slow response did not start")
        let stop = app.buttons["chat.stop"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 8), "stop button missing during streaming")
        stop.click()
        XCTAssertTrue(app.staticTexts["chat.message.status.cancelled"].firstMatch.waitForExistence(timeout: 15)
                      || waitForText("已停止", in: app, timeout: 2),
                      "cancelled state missing")
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(5))
        XCTAssertFalse(app.buttons["chat.stop"].firstMatch.exists, "stop button remained visible after cancellation")
        send("Reply with exactly: P11_AFTER_CANCEL_OK", in: app)
        XCTAssertTrue(waitForText("P11_AFTER_CANCEL_OK", in: app, timeout: 90), "post-cancel Ollama response missing")
        assertNoReasoningLeak(profileID: profileID)
        addScreenshot("gui-6-cancel-and-next-request", app: app)

        writeProfileEvidence(profileID: profileID)
    }

    @MainActor
    func testP11GateBRealOllamaDateTimeTool() throws {
        let profileID = "P11GateBTool-\(Self.shortUUID())"
        let app = launch(profileID: profileID, reset: true)
        defer { terminate(app) }

        openChat(app)
        assertProviderReady(in: app, model: "qwen3.5:0.8b")
        send("Use the available tool to get the current local date and time, then answer with a short sentence that starts with P11_TOOL_DONE.", in: app)
        XCTAssertTrue(waitForText("P11_TOOL_DONE", in: app, timeout: 120)
                      || waitForText("当前", in: app, timeout: 5)
                      || waitForText("时间", in: app, timeout: 5),
                      "tool continuation/final answer missing")
        assertFile(profileID: profileID,
                   fileName: "agent_task_activity.jsonl",
                   containsAny: ["get_current_datetime", "datetime", "date_time"],
                   timeout: 20)
        assertFile(profileID: profileID,
                   fileName: "agent_task_activity.jsonl",
                   containsAny: ["taskSucceeded", "completed"],
                   timeout: 20)
        assertNoReasoningLeak(profileID: profileID)
        addScreenshot("gui-4-tool-datetime-final", app: app)
        writeProfileEvidence(profileID: profileID)
    }

    @MainActor
    func testP11GateBProviderFailureRecovery() throws {
        let badProfile = "P11GateBBad-\(Self.shortUUID())"
        let badApp = launch(profileID: badProfile, model: "p11-missing-model-\(Self.shortUUID())", reset: true)
        openChat(badApp)
        assertProviderReady(in: badApp, model: "p11-missing-model")
        send("Reply with exactly: P11_SHOULD_FAIL", in: badApp)
        XCTAssertTrue(waitForText("当前选择的模型不可用", in: badApp, timeout: 60)
                      || waitForText("模型", in: badApp, timeout: 5)
                      || waitForText("失败", in: badApp, timeout: 5),
                      "provider failure was not visible")
        assertNoPermanentSpinner(in: badApp)
        addScreenshot("gui-7-provider-failure", app: badApp)
        terminate(badApp)

        let goodProfile = "P11GateBRecovery-\(Self.shortUUID())"
        let goodApp = launch(profileID: goodProfile, reset: true)
        defer { terminate(goodApp) }
        openChat(goodApp)
        send("Reply with exactly: P11_PROVIDER_RECOVERY_OK", in: goodApp)
        XCTAssertTrue(waitForText("P11_PROVIDER_RECOVERY_OK", in: goodApp, timeout: 90), "provider recovery response missing")
        assertNoReasoningLeak(profileID: goodProfile)
        addScreenshot("gui-7-provider-recovery", app: goodApp)
        writeProfileEvidence(profileID: goodProfile)
    }

    @MainActor
    func testP11GateBRelaunchRecovery() throws {
        let profileID = "P11GateBRelaunch-\(Self.shortUUID())"
        var app = launch(profileID: profileID, reset: true)
        openChat(app)
        send("Write a long answer in at least 1200 Chinese characters. Start with P11_RELAUNCH_STREAM and continue until the app quits.", in: app)
        XCTAssertTrue(waitForText("P11_RELAUNCH_STREAM", in: app, timeout: 45), "relaunch interrupt stream did not start")
        terminate(app)

        app = launch(profileID: profileID, reset: false)
        defer { terminate(app) }
        openChat(app)
        XCTAssertFalse(app.buttons["chat.stop"].firstMatch.waitForExistence(timeout: 3),
                       "relaunch restored an impossible active stop control")
        openTaskCenter(app)
        addScreenshot("gui-8-relaunch-task-center", app: app)
        openChat(app)
        send("Reply with exactly: P11_RELAUNCH_NEXT_OK", in: app)
        XCTAssertTrue(waitForText("P11_RELAUNCH_NEXT_OK", in: app, timeout: 90), "post-relaunch response missing")
        assertNoReasoningLeak(profileID: profileID)
        addScreenshot("gui-8-relaunch-next-request", app: app)
        writeProfileEvidence(profileID: profileID)
    }

    @MainActor
    private func launch(profileID: String,
                        model: String = "qwen3.5:0.8b",
                        reset: Bool) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--automation-profile", profileID,
            "--data-root", Self.automationDataRoot.path,
        ]
        if reset {
            app.launchArguments.append(contentsOf: ["--automation-reset-profile"])
        }
        app.launchEnvironment = [
            "DESKPET_AUTO_OPEN": "1",
            "DESKPET_AUTOMATION_OLLAMA_MODEL": model,
            "P6_XCUITEST_PROFILE_ID": profileID,
        ]
        app.launch()
        let indicator = app.descendants(matching: .any)["automation.profileIndicator"]
        XCTAssertTrue(indicator.waitForExistence(timeout: 15), app.debugDescription)
        writeEvidence("launch-\(profileID).txt", "profileID=\(profileID)\nmodel=\(model)\narguments=\(app.launchArguments.joined(separator: " "))")
        return app
    }

    @MainActor
    private func openChat(_ app: XCUIApplication) {
        let button = app.buttons["sidebar.chat"]
        XCTAssertTrue(button.waitForExistence(timeout: 8), app.debugDescription)
        button.click()
        XCTAssertTrue(app.descendants(matching: .any)["chat.input"].waitForExistence(timeout: 8), app.debugDescription)
    }

    @MainActor
    private func openTaskCenter(_ app: XCUIApplication) {
        let button = app.buttons["sidebar.taskCenter"]
        XCTAssertTrue(button.waitForExistence(timeout: 8), app.debugDescription)
        button.click()
        XCTAssertTrue(app.descendants(matching: .any)["task.list"].waitForExistence(timeout: 8)
                      || app.descendants(matching: .any)["task.detail"].waitForExistence(timeout: 8),
                      app.debugDescription)
    }

    @MainActor
    private func assertProviderReady(in app: XCUIApplication, model: String) {
        let selected = app.descendants(matching: .any)["provider.selected"]
        XCTAssertTrue(selected.waitForExistence(timeout: 15), app.debugDescription)
        let text = [selected.label, selected.value as? String].compactMap { $0 }.joined(separator: "\n")
        XCTAssertTrue(text.contains("Ollama") || app.descendants(matching: .any).matching(containing: "Ollama").firstMatch.exists,
                      "Ollama provider not visible. selected=\(text)")
        XCTAssertTrue(text.contains(model) || app.descendants(matching: .any).matching(containing: model).firstMatch.exists,
                      "model \(model) not visible. selected=\(text)")
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let input = app.descendants(matching: .any)["chat.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 8), "chat input missing")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        input.click()
        input.typeKey("v", modifierFlags: .command)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 8), "chat send button missing")
        send.click()
    }

    @MainActor
    private func waitForText(_ fragment: String, in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let predicate = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", fragment, fragment)
        if app.staticTexts.matching(predicate).firstMatch.waitForExistence(timeout: timeout) {
            return true
        }
        return app.descendants(matching: .any).matching(containing: fragment).firstMatch.waitForExistence(timeout: 0.5)
    }

    private func assertNoReasoningLeak(profileID: String) {
        let url = profileRoot(profileID: profileID)
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .appendingPathComponent("conversations.json")
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        let forbidden = ["<think>", "</think>", "reasoning_content", "hidden reasoning"]
        for fragment in forbidden {
            XCTAssertFalse(text.contains(fragment), "reasoning leaked in persisted conversation: \(fragment)")
        }
        writeEvidence("\(profileID)-reasoning-check.txt", "forbidden_found=false")
    }

    @MainActor
    private func assertNoPermanentSpinner(in app: XCUIApplication) {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(2))
        XCTAssertFalse(app.buttons["chat.stop"].firstMatch.exists, "chat remained busy")
    }

    private func assertFile(profileID: String,
                            fileName: String,
                            containsAny fragments: [String],
                            timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        let url = profileRoot(profileID: profileID)
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .appendingPathComponent(fileName)
        var text = ""
        repeat {
            text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            if fragments.contains(where: { text.contains($0) }) {
                writeEvidence("\(profileID)-\(fileName).txt", text)
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
        } while Date() < deadline
        XCTFail("\(url.path) did not contain any of \(fragments). Last text:\n\(text)")
    }

    private func writeProfileEvidence(profileID: String) {
        let root = profileRoot(profileID: profileID).appendingPathComponent("ApplicationSupport", isDirectory: true)
        for name in ["providers.json", "conversations.json", "agent_task_activity.jsonl", "agent_task_ledger.json"] {
            let url = root.appendingPathComponent(name)
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                writeEvidence("\(profileID)-\(name).txt", text)
            }
        }
    }

    private func profileRoot(profileID: String) -> URL {
        Self.automationDataRoot.appendingPathComponent(profileID, isDirectory: true)
    }

    @MainActor
    private func addScreenshot(_ name: String, app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        try? screenshot.pngRepresentation.write(to: evidenceRoot.appendingPathComponent("screenshots", isDirectory: true).appendingPathComponent("\(name).png"), options: .atomic)
    }

    private func writeEvidence(_ filename: String, _ text: String) {
        try? Data((text + "\n").utf8).write(to: evidenceRoot.appendingPathComponent("logs", isDirectory: true).appendingPathComponent(filename), options: .atomic)
    }

    @MainActor
    private func terminate(_ app: XCUIApplication) {
        app.terminate()
        _ = app.wait(for: .notRunning, timeout: 10)
    }

    private static func shortUUID() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8))
    }

    private static var automationDataRoot: URL {
        URL(fileURLWithPath: "/private/tmp/deskpet-p11-2-gateb-automation-data", isDirectory: true)
    }
}

private extension XCUIElementQuery {
    func matching(containing fragment: String) -> XCUIElementQuery {
        matching(NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", fragment, fragment))
    }
}
