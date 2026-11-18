import Foundation
import XCTest
import AICore
@testable import DeskPet

final class P62AutomationDataRootTests: XCTestCase {
    private let fileManager = FileManager.default
    private var ownedRoots: [URL] = []

    override func tearDownWithError() throws {
        for root in ownedRoots.reversed() {
            try? fileManager.removeItem(at: root)
        }
        ownedRoots.removeAll()
    }

    func testFoundationTemporaryDirectoryProbeCoversExpectedLocations() throws {
        let candidates: [(String, URL)] = [
            ("/tmp", URL(fileURLWithPath: "/tmp", isDirectory: true)),
            ("NSTemporaryDirectory", URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)),
            ("FileManager.temporaryDirectory", fileManager.temporaryDirectory),
            ("TMPDIR", URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory(),
                           isDirectory: true)),
        ]
        var passedLabels: [String] = []
        for (label, base) in candidates {
            let probe = base
                .appendingPathComponent("DeskPet-XCTest-Probe-\(UUID().uuidString)", isDirectory: true)
                .standardizedFileURL
            do {
                try fileManager.createDirectory(at: probe, withIntermediateDirectories: true)
                let file = probe.appendingPathComponent("probe")
                try Data("probe".utf8).write(to: file)
                try fileManager.removeItem(at: file)
                try fileManager.removeItem(at: probe)
                passedLabels.append(label)
            } catch {
                continue
            }
        }
        XCTAssertTrue(passedLabels.contains("NSTemporaryDirectory")
                      || passedLabels.contains("FileManager.temporaryDirectory")
                      || passedLabels.contains("TMPDIR"))
    }

    func testAppTemporaryModeUsesInjectedTemporaryDirectory() throws {
        let tempRoot = try makeTempRoot("app-temp")
        let env = try DeskPetAppEnvironment.automation(profileID: "P62Profile",
                                                       dataRootMode: .appTemporary,
                                                       temporaryDirectory: tempRoot)
        let profileRoot = try XCTUnwrap(env.paths.profileRoot)

        XCTAssertEqual(env.automationProfileID, "P62Profile")
        XCTAssertEqual(env.automationDataRootMode, .appTemporary)
        XCTAssertTrue(profileRoot.path.hasPrefix(tempRoot.appendingPathComponent("DeskPetAutomation").path + "/"))
        XCTAssertTrue(fileManager.fileExists(atPath: profileRoot.appendingPathComponent(".deskpet-automation-profile").path))
        XCTAssertTrue(env.secretStore is InMemorySecretStore)
    }

    func testExplicitModeKeepsExistingDataRootBehavior() throws {
        let explicitRoot = try makeTempRoot("explicit")
        let env = try DeskPetAppEnvironment.automation(profileID: "explicit_profile",
                                                       dataRoot: explicitRoot)
        let profileRoot = try XCTUnwrap(env.paths.profileRoot)

        XCTAssertEqual(env.automationProfileID, "explicit_profile")
        XCTAssertEqual(profileRoot.path, explicitRoot.appendingPathComponent("explicit_profile").path)
        XCTAssertTrue(env.paths.memoriesURL.path.hasPrefix(profileRoot.path + "/"))
        XCTAssertTrue(env.secretStore is InMemorySecretStore)
    }

    func testInjectedNormalModeDoesNotExposeAutomationIndicator() throws {
        let root = try makeTempRoot("normal")
        let env = try DeskPetAppEnvironment.normal(
            applicationSupportRoot: root.appendingPathComponent("support", isDirectory: true),
            cachesRoot: root.appendingPathComponent("caches", isDirectory: true),
            temporaryDirectory: root.appendingPathComponent("tmp", isDirectory: true)
        )

        XCTAssertNil(env.automationProfileID)
        XCTAssertNil(env.automationDataRootMode)
        XCTAssertNil(env.automationIndicatorInfo)
        XCTAssertTrue(env.paths.applicationSupportRoot.path.hasPrefix(root.path + "/"))
        XCTAssertTrue(env.paths.temporaryOutputDirectory.path.hasPrefix(root.path + "/"))
    }

    func testProfileIDTrimsWhitespaceAndRejectsUnsafeValues() throws {
        let tempRoot = try makeTempRoot("profile")
        let env = try DeskPetAppEnvironment.automation(profileID: "  Safe_Profile-01 \n",
                                                       dataRootMode: .appTemporary,
                                                       temporaryDirectory: tempRoot)
        XCTAssertEqual(env.automationProfileID, "Safe_Profile-01")

        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "",
                                                                  dataRootMode: .appTemporary,
                                                                  temporaryDirectory: tempRoot))
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "../bad",
                                                                  dataRootMode: .appTemporary,
                                                                  temporaryDirectory: tempRoot))
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "/absolute",
                                                                  dataRootMode: .appTemporary,
                                                                  temporaryDirectory: tempRoot))
    }

    func testSymlinkEscapeProfileIsRejected() throws {
        let tempRoot = try makeTempRoot("symlink")
        let dataRoot = tempRoot.appendingPathComponent("DeskPetAutomation", isDirectory: true)
        try fileManager.createDirectory(at: dataRoot, withIntermediateDirectories: true)
        let escapingProfile = dataRoot.appendingPathComponent("escape", isDirectory: true)
        try fileManager.createSymbolicLink(at: escapingProfile,
                                           withDestinationURL: tempRoot.deletingLastPathComponent())

        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "escape",
                                                                  dataRootMode: .appTemporary,
                                                                  temporaryDirectory: tempRoot))
    }

    func testAppTemporaryRootStaysInsideAllowedParent() throws {
        let tempRoot = try makeTempRoot("allowed-parent")
        let env = try DeskPetAppEnvironment.automation(profileID: "allowed",
                                                       dataRootMode: .appTemporary,
                                                       temporaryDirectory: tempRoot)
        let profileRoot = try XCTUnwrap(env.paths.profileRoot)
        let resolvedParent = tempRoot
            .appendingPathComponent("DeskPetAutomation", isDirectory: true)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        let resolvedProfile = profileRoot.resolvingSymlinksInPath().standardizedFileURL

        XCTAssertTrue(resolvedProfile.path.hasPrefix(resolvedParent.path + "/"))
        XCTAssertNotEqual(resolvedProfile.path, resolvedParent.path)
    }

    func testProfilesAreIsolatedAndSameProfilePersistsAcrossRestart() throws {
        let tempRoot = try makeTempRoot("profiles")
        let first = try DeskPetAppEnvironment.automation(profileID: "profileA",
                                                         dataRootMode: .appTemporary,
                                                         temporaryDirectory: tempRoot)
        let second = try DeskPetAppEnvironment.automation(profileID: "profileB",
                                                          dataRootMode: .appTemporary,
                                                          temporaryDirectory: tempRoot)
        try Data("profile-a-memory".utf8).write(to: first.paths.memoriesURL)
        XCTAssertFalse(fileManager.fileExists(atPath: second.paths.memoriesURL.path))

        let restarted = try DeskPetAppEnvironment.automation(profileID: "profileA",
                                                             dataRootMode: .appTemporary,
                                                             temporaryDirectory: tempRoot)
        XCTAssertEqual(restarted.paths.profileRoot, first.paths.profileRoot)
        XCTAssertEqual(try Data(contentsOf: restarted.paths.memoriesURL),
                       Data("profile-a-memory".utf8))
    }

    func testResetOnlyClearsCurrentProfileAndKeepsSiblingAndParent() throws {
        let tempRoot = try makeTempRoot("reset")
        let first = try DeskPetAppEnvironment.automation(profileID: "profileA",
                                                         dataRootMode: .appTemporary,
                                                         temporaryDirectory: tempRoot)
        let sibling = try DeskPetAppEnvironment.automation(profileID: "profileB",
                                                           dataRootMode: .appTemporary,
                                                           temporaryDirectory: tempRoot)
        try Data("remove-me".utf8).write(to: first.paths.memoriesURL)
        try Data("keep-me".utf8).write(to: sibling.paths.memoriesURL)
        let parent = try XCTUnwrap(first.paths.profileRoot?.deletingLastPathComponent())

        let reset = try DeskPetAppEnvironment.automation(profileID: "profileA",
                                                         dataRootMode: .appTemporary,
                                                         resetProfile: true,
                                                         temporaryDirectory: tempRoot)

        XCTAssertTrue(fileManager.fileExists(atPath: parent.path))
        XCTAssertTrue(fileManager.fileExists(atPath: try XCTUnwrap(reset.paths.profileRoot)
            .appendingPathComponent(".deskpet-automation-profile").path))
        XCTAssertFalse(fileManager.fileExists(atPath: reset.paths.memoriesURL.path))
        XCTAssertTrue(fileManager.fileExists(atPath: sibling.paths.memoriesURL.path))
        XCTAssertEqual(try Data(contentsOf: sibling.paths.memoriesURL), Data("keep-me".utf8))
    }

    func testDangerousRootsAndExplicitResetAreRejected() throws {
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "danger",
                                                                  dataRoot: URL(fileURLWithPath: "/", isDirectory: true)))
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "danger",
                                                                  dataRoot: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)))
        XCTAssertThrowsError(try DeskPetAppEnvironment.cleanAutomationProfileRoot(URL(fileURLWithPath: "/", isDirectory: true)))

        let explicitRoot = try makeTempRoot("explicit-reset")
        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "noExplicitReset",
                                                                  dataRootMode: .explicit(explicitRoot),
                                                                  resetProfile: true))
    }

    func testDataRootCreationFailureDoesNotReturnNormalEnvironment() throws {
        let tempRoot = try makeTempRoot("blocked")
        let fileRoot = tempRoot.appendingPathComponent("file-root")
        try Data("not-directory".utf8).write(to: fileRoot)

        XCTAssertThrowsError(try DeskPetAppEnvironment.automation(profileID: "blocked",
                                                                  dataRoot: fileRoot))
    }

    func testStoresAndIndicatorUseOneResolvedRoot() throws {
        let tempRoot = try makeTempRoot("stores")
        let env = try DeskPetAppEnvironment.automation(profileID: "storeProfile",
                                                       dataRootMode: .appTemporary,
                                                       temporaryDirectory: tempRoot)
        let profileRoot = try XCTUnwrap(env.paths.profileRoot)
        let mutablePaths = [
            env.paths.applicationSupportRoot,
            env.paths.conversationsURL,
            env.paths.memoriesURL,
            env.paths.tasksURL,
            env.paths.relationshipURL,
            env.paths.preferencesURL,
            env.paths.providersURL,
            env.paths.scheduledTasksURL,
            env.paths.agentTaskLedgerURL,
            env.paths.agentTaskActivityURL,
            env.paths.agentRunEventsDirectory,
            env.paths.logsDirectory,
            env.paths.diagnosticsURL,
            env.paths.cachesDirectory,
            env.paths.temporaryOutputDirectory,
            env.paths.workspaceRoot,
            try XCTUnwrap(env.paths.uiStateURL),
        ]
        for path in mutablePaths {
            XCTAssertTrue(path.path == profileRoot.path || path.path.hasPrefix(profileRoot.path + "/"),
                          "\(path.path) escaped \(profileRoot.path)")
        }

        let indicator = try XCTUnwrap(env.automationIndicatorInfo)
        XCTAssertEqual(indicator.rootMode, .appTemporary)
        XCTAssertEqual(indicator.accessibilityValue,
                       "profile=storeProfile; rootMode=appTemporary; isolation=ready")
    }

    private func makeTempRoot(_ label: String) throws -> URL {
        let root = fileManager.temporaryDirectory
            .appendingPathComponent("DeskPet-P62-\(label)-\(UUID().uuidString)", isDirectory: true)
            .standardizedFileURL
        try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
        ownedRoots.append(root)
        return root
    }
}
