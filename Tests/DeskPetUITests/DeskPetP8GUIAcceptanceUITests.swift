import AppKit
import Foundation
import XCTest

final class DeskPetP8GUIAcceptanceUITests: XCTestCase {
    private let fileManager = FileManager.default
    private var evidenceRoot: URL? {
        if let path = ProcessInfo.processInfo.environment["P6_XCUITEST_EVIDENCE_DIR"] {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: "/private/tmp/deskpet-p8-gui-evidence", isDirectory: true)
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testP8GUIFlow1OrdinaryStreamingAndFlow2DateTimeTool() throws {
        let app = launch(script: "p8_plain_chat", flow: "flow1-flow2")
        defer { terminate(app) }

        openChat(app)
        send("P8 GUI Flow 1 ordinary streaming chat", in: app)
        XCTAssertTrue(waitForText("P8 普通流式聊天", in: app), "Flow 1 response text missing")
        XCTAssertTrue(waitForText("RuntimeCoordinator", in: app), "Flow 1 runtime marker missing")
        XCTAssertFalse(app.descendants(matching: .any).matching(containing: "internal plan").firstMatch.exists)
        let profileID = profileID(from: app)
        assertActivity(profileID: profileID, contains: ["taskCreated", "taskSucceeded"])
        assertLedger(profileID: profileID, contains: ["responseDelta", "trueStreaming"])
        addScreenshot("p8-flow1-ordinary-streaming", app: app)

        send("What is the current local date and time?", in: app)
        XCTAssertTrue(waitForText("P8 loop automation complete", in: app), "Flow 2 final response missing")
        assertActivity(profileID: profileID, contains: [
            "get_current_datetime",
            "verificationStarted",
            "verificationSucceeded",
            "taskSucceeded"
        ])
        addScreenshot("p8-flow2-datetime-tool", app: app)
    }

    @MainActor
    func testP8GUIFlow3ToolFailure() throws {
        let app = launch(script: "p8_tool_failure", flow: "flow3")
        defer { terminate(app) }

        openChat(app)
        send("P8 GUI Flow 3 tool failure", in: app)
        assertActivity(profileID: profileID(from: app), contains: [
            "p8.fixture.missing_tool",
            "stepFailed",
            "taskFailed"
        ], timeout: 12)
        openTaskCenter(app)
        XCTAssertTrue(waitForText("任务未完成", in: app) || waitForText("失败", in: app),
                      "Flow 3 failure UI text missing")
        addScreenshot("p8-flow3-tool-failure", app: app)
    }

    @MainActor
    func testP8GUIFlow5AllowOnceAndFlow6Deny() throws {
        let allowApp = launch(script: "p8_permission_required", flow: "flow5")
        defer { terminate(allowApp) }
        let allowProfileID = profileID(from: allowApp)
        openChat(allowApp)
        send("P8 GUI Flow 5 allow once", in: allowApp)
        resolvePermission(.allowOnce, in: allowApp, flow: "flow5")
        assertActivity(profileID: allowProfileID, contains: [
            "automation.p8_reversible_write",
            "stepSucceeded",
            "taskSucceeded"
        ], timeout: 12)
        addScreenshot("p8-flow5-allow-once", app: allowApp)

        let denyApp = launch(script: "p8_permission_required", flow: "flow6")
        defer { terminate(denyApp) }
        let denyProfileID = profileID(from: denyApp)
        openChat(denyApp)
        send("P8 GUI Flow 6 deny permission", in: denyApp)
        resolvePermission(.deny, in: denyApp, flow: "flow6")
        assertActivity(profileID: denyProfileID, contains: [
            "automation.p8_reversible_write",
            "permissionDenied",
            "taskFailed"
        ], timeout: 12)
        addScreenshot("p8-flow6-deny", app: denyApp)
    }

    @MainActor
    func testP8GUIFlow7DynamicChoiceInteraction() throws {
        let app = launch(script: "p8_dynamic_choice", flow: "flow7")
        defer { terminate(app) }
        let profileID = profileID(from: app)

        openChat(app)
        send("P8 GUI Flow 7 dynamic choice", in: app)
        assertActivity(profileID: profileID, contains: ["resultProduced", "p8-gui-choice-result"], timeout: 12)
        openTaskCenter(app)
        if !waitForText("Alpha 候选", in: app) {
            writeEvidence("flow7-choice-ui.txt", describeCurrentUI(app))
            XCTFail("Flow 7 choice text missing")
        }
        let alphaChoice = app.buttons["result.choice.alpha"].firstMatch
        XCTAssertTrue(alphaChoice.waitForExistence(timeout: 5), "Flow 7 alpha choice button missing")
        addScreenshot("p8-flow7-before-choice-click", app: app)
        clickResultChoice(alphaChoice, flow: "flow7", in: app)
        assertActivity(profileID: profileID, contains: [
            "userInteractionResolved",
            "\"selectedChoiceID\":\"alpha\"",
            "已选择：Alpha 候选"
        ], timeout: 8)
        _ = waitForText("已选择", in: app, timeout: 2) || waitForText("选择已进入 Runtime 交互通道", in: app, timeout: 2)
        addScreenshot("p8-flow7-dynamic-choice", app: app)
    }

    @MainActor
    func testP8GUIFlow8CancelStreamingTask() throws {
        let app = launch(script: "p8_slow_chat", flow: "flow8")
        defer { terminate(app) }

        let profileID = profileID(from: app)
        openChat(app)
        send("P8 GUI Flow 8 cancel task tree", in: app)
        XCTAssertTrue(waitForText("P8 慢速流式聊天开始", in: app), "Flow 8 streaming text missing")
        let stop = app.buttons["chat.stop"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 8), "Flow 8 stop button missing")
        stop.click()
        let cancelledStatus = app.staticTexts["chat.message.status.cancelled"].firstMatch
        XCTAssertTrue(cancelledStatus.waitForExistence(timeout: 8) || waitForText("已停止", in: app, timeout: 1),
                      "Flow 8 cancelled text missing")
        assertActivity(profileID: profileID, contains: ["taskCancelled"], timeout: 8)
        assertConversation(profileID: profileID, contains: ["\"status\" : \"cancelled\""], timeout: 8)
        assertLedger(profileID: profileID, contains: ["\"kind\" : \"cancelled\"", "\"state\" : \"cancelled\""], timeout: 8)
        assertLedger(profileID: profileID, doesNotContain: ["\"kind\" : \"completed\"", "\"state\" : \"succeeded\""])
        addScreenshot("p8-flow8-cancel", app: app)
    }

    @MainActor
    private func launch(script: String, flow: String) -> XCUIApplication {
        let profileID = "P8GUI-\(flow)-\(Self.shortUUID())"
        let app = XCUIApplication()
        app.launchArguments = [
            "--automation-profile", profileID,
            "--data-root", Self.automationDataRoot.path,
        ]
        app.launchEnvironment = [
            "DESKPET_AUTO_OPEN": "1",
            "DESKPET_AUTOMATION_OLLAMA_MODEL": "p8-scripted",
            "DESKPET_AUTOMATION_AGENT_SCRIPT": script,
            "P6_XCUITEST_PROFILE_ID": profileID,
        ]
        app.launch()

        let indicator = app.descendants(matching: .any)["automation.profileIndicator"]
        XCTAssertTrue(indicator.waitForExistence(timeout: 10), "automation profile indicator missing")
        allowSystemFileAccessPromptIfPresent(in: app)
        writeEvidence("\(flow)-launch.txt", """
        profileID=\(profileID)
        script=\(script)
        activityURL=\(activityURL(profileID: profileID).path)
        """)
        return app
    }

    @MainActor
    private func openChat(_ app: XCUIApplication) {
        allowSystemFileAccessPromptIfPresent(in: app)
        let button = app.buttons["sidebar.chat"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "chat sidebar button missing")
        button.click()
        XCTAssertTrue(app.descendants(matching: .any)["chat.input"].waitForExistence(timeout: 5), "chat input missing")
    }

    @MainActor
    private func openTaskCenter(_ app: XCUIApplication) {
        allowSystemFileAccessPromptIfPresent(in: app)
        let button = app.buttons["sidebar.taskCenter"]
        XCTAssertTrue(button.waitForExistence(timeout: 5), "task center sidebar button missing")
        button.click()
        allowSystemFileAccessPromptIfPresent(in: app)
        let all = app.buttons["全部任务"].firstMatch
        if all.waitForExistence(timeout: 2) { all.click() }
    }

    @MainActor
    private func selectTask(containing fragment: String, in app: XCUIApplication) {
        let row = app.buttons.matching(containing: fragment).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5), "task row \(fragment) missing")
        row.click()
    }

    @MainActor
    private func clickResultChoice(_ button: XCUIElement, flow: String, in app: XCUIApplication) {
        allowSystemFileAccessPromptIfPresent(in: app)
        for _ in 0..<5 {
            if button.exists, button.isHittable {
                break
            }
            let scrollView = app.scrollViews.firstMatch
            if scrollView.waitForExistence(timeout: 0.3), scrollView.isHittable {
                scrollView.swipeUp()
            } else {
                app.swipeUp()
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
            allowSystemFileAccessPromptIfPresent(in: app)
        }

        if button.exists, button.isHittable {
            button.click()
            return
        }

        writeEvidence("\(flow)-choice-not-hittable.txt", describeCurrentUI(app))
        XCTAssertTrue(button.exists, "\(flow) choice button missing after scroll")
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.12, dy: 0.5)).click()
    }

    @MainActor
    private func allowSystemFileAccessPromptIfPresent(in app: XCUIApplication) {
        clickPotentialSystemAllowButton(in: app)
        let hasChinesePrompt = app.staticTexts.matching(containing: "想访问").firstMatch.waitForExistence(timeout: 0.4)
            || app.staticTexts.matching(containing: "可移除").firstMatch.exists
        let hasEnglishPrompt = app.staticTexts.matching(containing: "would like to access").firstMatch.exists
            || app.staticTexts.matching(containing: "removable volume").firstMatch.exists
        guard hasChinesePrompt || hasEnglishPrompt else { return }

        if clickFirstExistingButton(["允许", "Allow"], in: app, timeout: 1) {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
        }
    }

    @MainActor
    private func clickPotentialSystemAllowButton(in app: XCUIApplication) {
        let mainWindow = app.windows["桌宠 · 陪伴台"].firstMatch
        let window = mainWindow.exists ? mainWindow : app.windows.element(boundBy: 3)
        guard window.exists else { return }
        window.coordinate(withNormalizedOffset: CGVector(dx: 0.62, dy: 0.37)).click()
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.2))
    }

    @MainActor
    private func send(_ text: String, in app: XCUIApplication) {
        let input = app.descendants(matching: .any)["chat.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5), "chat input missing")
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        input.click()
        input.typeKey("v", modifierFlags: .command)
        let send = app.buttons["chat.send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "chat send button missing")
        send.click()
    }

    @MainActor
    private enum PermissionDecision {
        case allowOnce
        case deny
    }

    @MainActor
    private func resolvePermission(_ decision: PermissionDecision, in app: XCUIApplication, flow: String) {
        let deadline = Date().addingTimeInterval(14)
        var openedTaskCenter = false
        var approvedPlan = false

        repeat {
            if !approvedPlan,
               clickFirstExistingButton(["允许执行", "批准"], in: app, timeout: 0.3) {
                approvedPlan = true
                continue
            }

            switch decision {
            case .allowOnce:
                if clickFirstExistingButton(["允许一次"], in: app, timeout: 0.3) {
                    return
                }
            case .deny:
                if clickFirstExistingButton(["拒绝"], in: app, timeout: 0.3) {
                    return
                }
            }

            if !openedTaskCenter, Date() > deadline.addingTimeInterval(-10) {
                openTaskCenter(app)
                openedTaskCenter = true
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        } while Date() < deadline

        writeEvidence("\(flow)-permission-ui.txt", describeCurrentUI(app))
        XCTFail("permission decision \(decision) UI missing for \(flow)")
    }

    @MainActor
    private func clickFirstExistingButton(_ titles: [String],
                                          in app: XCUIApplication,
                                          timeout: TimeInterval) -> Bool {
        for title in titles {
            let button = app.buttons[title].firstMatch
            if button.waitForExistence(timeout: timeout), button.isHittable {
                button.click()
                return true
            }
        }
        return false
    }

    @MainActor
    private func describeCurrentUI(_ app: XCUIApplication) -> String {
        let buttons = app.buttons.allElementsBoundByIndex
            .prefix(40)
            .map { $0.label }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        let texts = app.staticTexts.allElementsBoundByIndex
            .prefix(60)
            .map { $0.label }
            .filter { !$0.isEmpty }
            .joined(separator: "\n")
        return """
        buttons:
        \(buttons)

        texts:
        \(texts)
        """
    }

    @MainActor
    private func waitForText(_ fragment: String, in app: XCUIApplication, timeout: TimeInterval = 8) -> Bool {
        let textPredicate = NSPredicate(format: "label CONTAINS[c] %@ OR value CONTAINS[c] %@", fragment, fragment)
        if app.staticTexts.matching(textPredicate).firstMatch.waitForExistence(timeout: timeout) {
            return true
        }
        return app.descendants(matching: .any).matching(containing: fragment).firstMatch.waitForExistence(timeout: 0.5)
    }

    private func assertActivity(profileID: String,
                                contains fragments: [String],
                                timeout: TimeInterval = 8,
                                file: StaticString = #filePath,
                                line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        let url = activityURL(profileID: profileID)
        var text = ""
        repeat {
            text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            if fragments.allSatisfy({ text.contains($0) }) {
                writeEvidence("activity-\(profileID).txt", text)
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTFail("activity log \(url.path) did not contain \(fragments). Last text:\n\(text)", file: file, line: line)
    }

    private func assertLedger(profileID: String,
                              contains fragments: [String],
                              timeout: TimeInterval = 8,
                              file: StaticString = #filePath,
                              line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        let url = ledgerURL(profileID: profileID)
        var text = ""
        repeat {
            text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            if fragments.allSatisfy({ text.contains($0) }) {
                writeEvidence("ledger-\(profileID).txt", text)
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTFail("ledger \(url.path) did not contain \(fragments). Last text:\n\(text)", file: file, line: line)
    }

    private func activityURL(profileID: String) -> URL {
        let base = Self.automationDataRoot
            .appendingPathComponent(profileID, isDirectory: true)
        return base
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .appendingPathComponent("agent_task_activity.jsonl")
    }

    private func ledgerURL(profileID: String) -> URL {
        let base = Self.automationDataRoot
            .appendingPathComponent(profileID, isDirectory: true)
        return base
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .appendingPathComponent("agent_task_ledger.json")
    }

    private func conversationURL(profileID: String) -> URL {
        let base = Self.automationDataRoot
            .appendingPathComponent(profileID, isDirectory: true)
        return base
            .appendingPathComponent("ApplicationSupport", isDirectory: true)
            .appendingPathComponent("conversations.json")
    }

    private func assertConversation(profileID: String,
                                    contains fragments: [String],
                                    timeout: TimeInterval = 8,
                                    file: StaticString = #filePath,
                                    line: UInt = #line) {
        let deadline = Date().addingTimeInterval(timeout)
        let url = conversationURL(profileID: profileID)
        var text = ""
        repeat {
            text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            if fragments.allSatisfy({ text.contains($0) }) {
                writeEvidence("conversation-\(profileID).txt", text)
                return
            }
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTFail("conversation \(url.path) did not contain \(fragments). Last text:\n\(text)", file: file, line: line)
    }

    private func assertLedger(profileID: String,
                              doesNotContain fragments: [String],
                              file: StaticString = #filePath,
                              line: UInt = #line) {
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.5))
        let url = ledgerURL(profileID: profileID)
        let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        for fragment in fragments {
            XCTAssertFalse(text.contains(fragment),
                           "ledger \(url.path) unexpectedly contained \(fragment). Text:\n\(text)",
                           file: file,
                           line: line)
        }
        writeEvidence("ledger-\(profileID).txt", text)
    }

    @MainActor
    private func profileID(from app: XCUIApplication) -> String {
        let indicator = app.descendants(matching: .any)["automation.profileIndicator"]
        let value = [indicator.label, indicator.value as? String]
            .compactMap { $0 }
            .joined(separator: "\n")
        let marker = "profile="
        guard let range = value.range(of: marker) else {
            if let profile = value.components(separatedBy: "AUTOMATION PROFILE: ").dropFirst().first {
                return String(profile.split(separator: " ").first ?? "")
            }
            return ""
        }
        let suffix = value[range.upperBound...]
        return String(suffix.split(separator: ";").first ?? "")
    }

    @MainActor
    private func addScreenshot(_ name: String, app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        guard let evidenceRoot else { return }
        let screenshots = evidenceRoot.appendingPathComponent("screenshots", isDirectory: true)
        try? fileManager.createDirectory(at: screenshots, withIntermediateDirectories: true)
        try? screenshot.pngRepresentation.write(to: screenshots.appendingPathComponent("\(name).png"), options: .atomic)
        _ = app
    }

    private func writeEvidence(_ filename: String, _ text: String) {
        guard let evidenceRoot else { return }
        let logs = evidenceRoot.appendingPathComponent("logs", isDirectory: true)
        try? fileManager.createDirectory(at: logs, withIntermediateDirectories: true)
        try? Data((text + "\n").utf8).write(to: logs.appendingPathComponent(filename), options: .atomic)
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
        URL(fileURLWithPath: "/private/tmp/deskpet-p8-gui-automation-data", isDirectory: true)
    }
}

private extension XCUIElementQuery {
    func matching(containing fragment: String) -> XCUIElementQuery {
        matching(NSPredicate(format: "label CONTAINS[c] %@", fragment))
    }
}
