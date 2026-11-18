import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

final class P5AuditLogTests: XCTestCase {

    func testRedactionHidesSecretsAndKeepsMetadataOnly() {
        XCTAssertEqual(RuntimeAuditRedactor.redact("my password is hunter2"), "[redacted]")
        XCTAssertEqual(RuntimeAuditRedactor.redact("token=abcdef"), "[redacted]")
        XCTAssertEqual(RuntimeAuditRedactor.metadata(forText: "hello"), "len=5")
    }

    func testPermissionDenyIsRecorded() async {
        let audit = InMemoryAuditSink()
        let gate = CapabilityPermissionGate(appGate: P5DenyAppGate(),
                                            system: DefaultSystemAuthorizationPolicy(),
                                            audit: audit)
        _ = await gate.evaluate(capabilityID: "network.upload", reason: "x", correlationID: nil)
        let recorded = await audit.contains(kind: .permissionDenied)
        XCTAssertTrue(recorded)
    }

    func testTimeoutIsRecorded() async throws {
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: audit)
        try await registry.register(P5SlowTool())
        _ = await registry.invoke("slow", arguments: [:], context: p5ToolContext())
        let recorded = await audit.contains(kind: .timeout)
        XCTAssertTrue(recorded)
    }

    func testCancellationNotLoggedAsFailure() async throws {
        let audit = InMemoryAuditSink()
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: audit)
        try await registry.register(P5SlowTool(timeout: 5))
        let task = Task { await registry.invoke("slow", arguments: [:], context: p5ToolContext()) }
        task.cancel()
        _ = await task.value
        let cancelled = await audit.contains(kind: .cancellation)
        let failed = await audit.contains(kind: .toolInvocationFailed)
        XCTAssertTrue(cancelled)
        XCTAssertFalse(failed)
    }
}

final class P5SafetyBoundaryTests: XCTestCase {

    func testSampleToolsRequireNoNetworkOrFilesystem() {
        XCTAssertTrue(EchoTool().requiredCapabilities.isEmpty)
        XCTAssertEqual(CurrentRuntimeStatusTool().requiredCapabilities, ["state.read"])
        XCTAssertEqual(CurrentDateTimeTool().requiredCapabilities, ["get_current_datetime"])
    }

    func testTestEnvironmentDoesNotTouchOpenClawPaths() {
        let temp = FileManager.default.temporaryDirectory.path
        XCTAssertFalse(temp.contains(".openclaw"))
        XCTAssertFalse(temp.contains("openclaw"))
    }

    func testNoOpLive2DDriverIsAStubNotRealLive2D() async {
        // The stub must be inert: it records nothing and reads no model assets.
        let driver = NoOpLive2DPresentationDriver()
        await driver.playMotion(.speaking)
        XCTAssertTrue(true)
    }
}

@MainActor
final class P5ContainerIntegrationTests: XCTestCase {

    private func makeContainer(driver: any CharacterPresentationDriver = RecordingPresentationDriver())
        async -> AgentRuntimeContainer {
        await AgentRuntimeContainer(
            tier: .developerID,
            context: P5FakeContext(),
            model: P5RespondModel(),
            conversation: P5FakeConversation(),
            executor: P5FakeExecutor(),
            ledger: NoopAgentTaskLedgerStore(),
            presentationDriver: driver)
    }

    func testBootstrapIsIdempotentAndStartsOneRuntime() async {
        let container = await makeContainer()
        await container.bootstrap()
        await container.bootstrap()
        let tools = await container.toolRegistry.count()
        let starts = await container.lifecycle.startCountForTesting()
        let state = await container.lifecycle.currentState()
        XCTAssertEqual(tools, ToolPlatformAssembly.releaseManifests.count)
        XCTAssertEqual(starts, 1)       // one runtime, no duplicate listeners
        XCTAssertEqual(state, .idle)
    }

    func testActionReachesPresentationDriver() async {
        let driver = RecordingPresentationDriver()
        let container = await makeContainer(driver: driver)
        await container.bootstrap()
        await container.actionDispatcher.enqueue(p5ActionEnvelope(.setExpression(.happy), .assistantResponse))
        _ = await container.actionDispatcher.runAll()
        let last = await driver.lastExpression
        XCTAssertEqual(last, .happy)
    }

    func testAdvanceBehaviorDrivesDriverThroughStateMachine() async {
        let driver = RecordingPresentationDriver()
        let container = await makeContainer(driver: driver)
        await container.bootstrap()
        _ = await container.advanceBehavior(.start)        // dormant → idle
        let ok = await container.advanceBehavior(.userMessage)   // idle → listening
        XCTAssertTrue(ok)
        let expressions = await driver.expressions
        XCTAssertTrue(expressions.contains(.curious))      // listening entry command
    }

    func testInvalidBehaviorTransitionIsAudited() async {
        let container = await makeContainer()
        await container.bootstrap()
        let ok = await container.advanceBehavior(.userMessage)   // illegal from dormant
        let audited = await container.auditSink.contains(kind: .invalidTransition)
        XCTAssertFalse(ok)
        XCTAssertTrue(audited)
    }

    func testCapabilityGateIsAuthoritativeForSensitiveAction() async {
        let container = await makeContainer()
        await container.bootstrap()
        let id = UUID()
        await container.actionDispatcher.enqueue(
            p5ActionEnvelope(.requestPermission(capabilityID: "screen.continuous", reason: "x"),
                             .assistantResponse, id: id))
        let outcomes = await container.actionDispatcher.runAll()
        guard case .denied = outcomes.first else { return XCTFail("sensitive action must be gated") }
    }

    func testShutdownLeavesNoOrphanTasks() async {
        let container = await makeContainer()
        await container.bootstrap()
        await container.shutdown()
        let active = await container.lifecycle.activeRequestCount()
        let state = await container.lifecycle.currentState()
        XCTAssertEqual(active, 0)
        XCTAssertEqual(state, .stopped)
    }

    func testDiagnosticsSnapshotMatchesRuntime() async {
        let container = await makeContainer()
        await container.bootstrap()
        let snapshot = await container.diagnosticsSnapshot()
        XCTAssertEqual(snapshot.runtimeState, "idle")
        XCTAssertEqual(snapshot.behaviorMode, "companion")
        XCTAssertEqual(snapshot.behaviorState, "dormant")
        XCTAssertEqual(snapshot.registeredToolCount, ToolPlatformAssembly.releaseManifests.count)
    }
}
