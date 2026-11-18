import Foundation
import AppKit
import XCTest

final class DeskPetMinimumSmokeUITests: XCTestCase {
    private let fileManager = FileManager.default
    private var evidenceRoot: URL? {
        ProcessInfo.processInfo.environment["P6_XCUITEST_EVIDENCE_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    @MainActor
    func testMinimumSmokeLaunchesAutomationProfileAndClicksStableControl() throws {
        let profileID = "P6XCUITestSmoke-\(Self.shortUUID())"
        let app = XCUIApplication()
        app.launchArguments = [
            "--automation-profile", profileID,
            "--automation-data-root-mode", "app-temporary",
            "--automation-reset-profile",
        ]
        app.launchEnvironment = [
            "DESKPET_AUTO_OPEN": "1",
            "DESKPET_AUTOMATION_OLLAMA_MODEL": "qwen3.5:0.8b",
            "P6_XCUITEST_PROFILE_ID": profileID,
        ]

        app.launch()
        writeEvidence("app_launch.txt", """
        launchArguments=\(app.launchArguments.joined(separator: " "))
        profileID=\(profileID)
        rootMode=appTemporary
        """)

        let indicator = app.descendants(matching: .any)["automation.profileIndicator"]
        XCTAssertTrue(indicator.waitForExistence(timeout: 10), app.debugDescription)
        let indicatorText = [indicator.label, indicator.value as? String]
            .compactMap { $0 }
            .joined(separator: "\n")
        XCTAssertTrue(indicatorText.contains(profileID), indicatorText)
        XCTAssertTrue(indicatorText.contains("rootMode=appTemporary") || indicatorText.contains("App Temporary"), indicatorText)
        XCTAssertTrue(indicatorText.contains("isolation=ready") || indicatorText.contains("ready"), indicatorText)
        addScreenshot(name: "minimum-smoke-after-launch", app: app)

        let chatButton = app.buttons["sidebar.chat"]
        XCTAssertTrue(chatButton.waitForExistence(timeout: 5), app.debugDescription)
        chatButton.click()

        let input = app.descendants(matching: .any)["chat.input"]
        XCTAssertTrue(input.waitForExistence(timeout: 5), app.debugDescription)
        addScreenshot(name: "minimum-smoke-chat-input", app: app)

        let providerButton = app.buttons["sidebar.provider"]
        XCTAssertTrue(providerButton.waitForExistence(timeout: 5), app.debugDescription)
        providerButton.click()

        let providerStatus = app.descendants(matching: .any)["provider.status"]
        XCTAssertTrue(providerStatus.waitForExistence(timeout: 5), app.debugDescription)
        addScreenshot(name: "minimum-smoke-provider-clicked", app: app)

        app.terminate()
        XCTAssertTrue(app.wait(for: .notRunning, timeout: 10))
        let residualPIDs = residualDeskPetPIDs()
        XCTAssertTrue(residualPIDs.isEmpty, "DeskPet process remained after terminate: \(residualPIDs)")
    }

    @MainActor
    private func addScreenshot(name: String, app: XCUIApplication) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let evidenceRoot else { return }
        let screenshots = evidenceRoot.appendingPathComponent("screenshots", isDirectory: true)
        try? fileManager.createDirectory(at: screenshots, withIntermediateDirectories: true)
        let timestamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = screenshots.appendingPathComponent("\(name)-\(timestamp).png")
        try? screenshot.pngRepresentation.write(to: url, options: .atomic)
        _ = app
    }

    private func residualDeskPetPIDs() -> [String] {
        NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.deskpet.companion")
            .filter { !$0.isTerminated }
            .map { String($0.processIdentifier) }
    }

    private func writeEvidence(_ filename: String, _ text: String) {
        guard let evidenceRoot else { return }
        let logs = evidenceRoot.appendingPathComponent("logs", isDirectory: true)
        try? fileManager.createDirectory(at: logs, withIntermediateDirectories: true)
        try? Data((text + "\n").utf8)
            .write(to: logs.appendingPathComponent(filename), options: .atomic)
    }

    private static func shortUUID() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8))
    }
}
