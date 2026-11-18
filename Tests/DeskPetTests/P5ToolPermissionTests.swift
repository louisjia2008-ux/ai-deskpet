import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

final class P5ToolRegistryTests: XCTestCase {

    func testRegisterAndDuplicateRejected() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(EchoTool())
        do {
            try await registry.register(EchoTool())
            XCTFail("duplicate identifier should throw")
        } catch RuntimeToolError.duplicateIdentifier(let id) {
            XCTAssertEqual(id, "echo")
        }
        let count = await registry.count()
        XCTAssertEqual(count, 1)
    }

    func testUnregisteredInvokeFails() async {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        let result = await registry.invoke("nope", arguments: [:], context: p5ToolContext())
        guard case .failure(.notFound) = result else { return XCTFail("expected notFound") }
    }

    func testCapabilityNotPermittedBlocks() async throws {
        let registry = ToolRegistry(gate: P5DenyPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(CurrentRuntimeStatusTool())   // requires state.read
        let result = await registry.invoke("runtime.status", arguments: [:], context: p5ToolContext())
        guard case .failure(.capabilityNotPermitted) = result else {
            return XCTFail("expected capabilityNotPermitted")
        }
    }

    func testEchoExecutes() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(EchoTool())
        let result = await registry.invoke("echo", arguments: ["text": "hi"], context: p5ToolContext())
        guard case .success(let value) = result else { return XCTFail("expected success") }
        XCTAssertEqual(value.output, "hi")
    }

    func testTimeoutHonored() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(P5SlowTool())
        let result = await registry.invoke("slow", arguments: [:], context: p5ToolContext())
        guard case .failure(.timedOut) = result else { return XCTFail("expected timedOut") }
    }

    func testCancellationHonored() async throws {
        let registry = ToolRegistry(gate: P5AllowPermissionGate(), audit: InMemoryAuditSink())
        try await registry.register(P5SlowTool(timeout: 5))
        let task = Task { await registry.invoke("slow", arguments: [:], context: p5ToolContext()) }
        task.cancel()
        let result = await task.value
        guard case .failure(.cancelled) = result else { return XCTFail("expected cancelled") }
    }
}

final class P5PermissionModelTests: XCTestCase {

    func testP0CapabilityIsExecutable() async {
        let gate = CapabilityPermissionGate(appGate: BrokerCapabilityGate(tier: .developerID),
                                            system: DefaultSystemAuthorizationPolicy(),
                                            audit: InMemoryAuditSink())
        let permission = await gate.evaluate(capabilityID: "state.read", reason: "x", correlationID: nil)
        XCTAssertTrue(permission.isExecutable)
    }

    func testHighSensitivityDefaultDenied() async {
        let gate = CapabilityPermissionGate(appGate: BrokerCapabilityGate(tier: .developerID),
                                            system: DefaultSystemAuthorizationPolicy(),
                                            audit: InMemoryAuditSink())
        let screen = await gate.evaluate(capabilityID: "screen.environment.read", reason: "x", correlationID: nil)
        XCTAssertFalse(screen.isExecutable)               // P1 → askUser AND system-gated
    }

    func testAppGrantedButSystemNotAuthorizedIsNotExecutable() async {
        let system = InMemorySystemAuthorizationStore()
        let gate = CapabilityPermissionGate(appGate: P5AllowAppGate(), system: system, audit: InMemoryAuditSink())
        let before = await gate.evaluate(capabilityID: "screen.continuous", reason: "x", correlationID: nil)
        XCTAssertTrue(before.applicationPolicyGranted)
        XCTAssertTrue(before.systemAuthorizationRequired)
        XCTAssertFalse(before.isExecutable)               // app yes, system not yet

        await system.set(.granted, for: "screen.continuous")
        let after = await gate.evaluate(capabilityID: "screen.continuous", reason: "x", correlationID: nil)
        XCTAssertTrue(after.isExecutable)                 // now both
    }

    func testGrantedOnceConsumedOnce() async {
        let store = InMemoryPermissionStore()
        await store.set(.grantedOnce, for: "reminders.create")
        let first = await store.consume("reminders.create")
        let second = await store.consume("reminders.create")
        XCTAssertTrue(first)
        XCTAssertFalse(second)
    }

    func testGrantedForSessionRepeats() async {
        let store = InMemoryPermissionStore()
        await store.set(.grantedForSession, for: "reminders.read")
        let a = await store.consume("reminders.read")
        let b = await store.consume("reminders.read")
        XCTAssertTrue(a)
        XCTAssertTrue(b)
    }

    func testNotRequestedDefaultsToDenied() async {
        let store = InMemoryPermissionStore()
        let state = await store.state(for: "microphone")
        let allowed = await store.consume("microphone")
        XCTAssertEqual(state, .notRequested)
        XCTAssertFalse(allowed)
    }

    func testAgentModeCannotBypassGate() async {
        XCTAssertTrue(BehaviorPolicy(mode: .agentWorking).decide(environment: .normal).allowSensitiveCapability)
        let gate = CapabilityPermissionGate(appGate: P5AllowAppGate(),
                                            system: DefaultSystemAuthorizationPolicy(),
                                            audit: InMemoryAuditSink())
        let permission = await gate.evaluate(capabilityID: "accessibility.global", reason: "x", correlationID: nil)
        XCTAssertFalse(permission.isExecutable)           // policy allows mode, gate still denies
    }
}
