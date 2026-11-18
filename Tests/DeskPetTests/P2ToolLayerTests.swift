import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P2 — real tool layer: pure sandbox/url helpers, capability routing, the in-process EventKit/timer
// executor, and the decision validator now accepting the new capabilities (without weakening escape
// defenses).

// MARK: - Pure helpers (AICore)

final class WorkspacePathResolverTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/private/tmp/deskpet-ws", isDirectory: true)

    func testAcceptsNormalRelativePath() throws {
        let url = try WorkspacePathResolver.resolve("notes/today.md", root: root)
        XCTAssertTrue(url.path.hasPrefix("/private/tmp/deskpet-ws/"))
        XCTAssertTrue(url.path.hasSuffix("notes/today.md"))
    }
    func testRejectsParentTraversal() {
        XCTAssertThrowsError(try WorkspacePathResolver.resolve("../escape", root: root))
        XCTAssertThrowsError(try WorkspacePathResolver.resolve("a/../../escape", root: root))
    }
    func testRejectsAbsoluteAndTilde() {
        XCTAssertThrowsError(try WorkspacePathResolver.resolve("/etc/passwd", root: root))
        XCTAssertThrowsError(try WorkspacePathResolver.resolve("~/secrets", root: root))
        XCTAssertThrowsError(try WorkspacePathResolver.resolve("", root: root))
    }
    func testStructuralUnsafeMatchesResolve() {
        XCTAssertTrue(WorkspacePathResolver.isStructurallyUnsafe("../x"))
        XCTAssertTrue(WorkspacePathResolver.isStructurallyUnsafe("/abs"))
        XCTAssertTrue(WorkspacePathResolver.isStructurallyUnsafe("~/x"))
        XCTAssertFalse(WorkspacePathResolver.isStructurallyUnsafe("ok/path.txt"))
    }
}

final class FetchTargetValidatorTests: XCTestCase {
    func testAllowsPublicHTTPS() {
        XCTAssertTrue(FetchTargetValidator.isAcceptable("https://example.com/page"))
        XCTAssertTrue(FetchTargetValidator.isAcceptable("https://api.duckduckgo.com/?q=swift"))
    }
    func testRejectsNonHTTPS() {
        XCTAssertFalse(FetchTargetValidator.isAcceptable("http://example.com"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("file:///etc/passwd"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("ftp://example.com"))
    }
    func testRejectsLocalAndPrivateHosts() {
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://localhost/x"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://127.0.0.1/x"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://10.0.0.5/x"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://192.168.1.1/x"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://172.16.0.1/x"))
        XCTAssertFalse(FetchTargetValidator.isAcceptable("https://169.254.0.1/x"))
    }
}

// MARK: - Executor fakes

private actor RecordingExecutor: ToolExecuting {
    let label: String
    private(set) var seen: [String] = []
    init(label: String) { self.label = label }
    func execute(step: AgentPlanStep, token: CapabilityToken) async -> ToolOutcome {
        seen.append(step.capabilityID)
        return ToolOutcome(ok: true, output: "\(label):\(step.capabilityID)")
    }
    func capabilities() -> [String] { seen }
}

private actor FakeEventKit: EventKitAccess {
    private(set) var reminderTitles: [String] = []
    private(set) var calendarTitles: [String] = []
    var failReminder = false
    func setFailReminder(_ v: Bool) { failReminder = v }

    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure> {
        reminderTitles.append(title)
        return failReminder ? .failure(ToolFailure(message: "提醒权限未授予")) : .success("rem-1")
    }
    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure> {
        calendarTitles.append(title); return .success("evt-1")
    }
    func readReminders(limit: Int) async -> Result<[String], ToolFailure> { .success(["买牛奶", "交报告"]) }
    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure> { .success(["06-26 09:00 周会"]) }
}

private final class TimerRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _calls: [(TimeInterval, String)] = []
    func record(_ s: TimeInterval, _ t: String) { lock.lock(); _calls.append((s, t)); lock.unlock() }
    var calls: [(TimeInterval, String)] { lock.lock(); defer { lock.unlock() }; return _calls }
}

private func token() -> CapabilityToken { CapabilityToken(raw: "t", taskID: UUID(), expiresAt: .distantFuture) }
private func step(_ cap: String, _ params: [String: String] = [:]) -> AgentPlanStep {
    AgentPlanStep(description: "d", capabilityID: cap, params: params)
}

// MARK: - Routing

final class CompositeToolExecutorTests: XCTestCase {
    func testRoutesOSCapabilitiesInProcessAndRestToRunner() async {
        let inproc = RecordingExecutor(label: "in")
        let isolated = RecordingExecutor(label: "iso")
        let composite = CompositeToolExecutor(inProcess: inproc, isolated: isolated)

        _ = await composite.execute(step: step("timer.local"), token: token())
        _ = await composite.execute(step: step("reminder.local.create"), token: token())
        _ = await composite.execute(step: step("network.fetch"), token: token())
        _ = await composite.execute(step: step("filesystem.workspace.read"), token: token())

        let inSeen = await inproc.capabilities()
        let isoSeen = await isolated.capabilities()
        XCTAssertEqual(Set(inSeen), ["timer.local", "reminder.local.create"])
        XCTAssertEqual(Set(isoSeen), ["network.fetch", "filesystem.workspace.read"])
    }

    func testPublicRunnerFailsClosedForGenericNetworking() {
        XCTAssertFalse(ToolRunnerCapabilities.implemented.contains("network.fetch"))
        XCTAssertFalse(ToolRunnerCapabilities.implemented.contains("network.search"))
        XCTAssertEqual(ToolRunnerCapabilities.unavailableForSecurity,
                       ["network.fetch", "network.search"])
    }
}

// MARK: - In-process executor

final class InProcessToolExecutorTests: XCTestCase {
    private func makeExecutor(_ ek: FakeEventKit, _ rec: TimerRecorder) -> InProcessToolExecutor {
        InProcessToolExecutor(eventKit: ek, scheduleTimer: { s, t in rec.record(s, t) })
    }

    func testTimerSchedulesAndReportsOK() async {
        let rec = TimerRecorder()
        let exec = makeExecutor(FakeEventKit(), rec)
        let out = await exec.execute(step: step("timer.local", ["durationSeconds": "180", "title": "喝水"]), token: token())
        XCTAssertTrue(out.ok)
        XCTAssertEqual(rec.calls.count, 1)
        XCTAssertEqual(rec.calls.first?.0, 180)
        XCTAssertEqual(rec.calls.first?.1, "喝水")
        XCTAssertTrue(out.output.contains("已设定"))
    }

    func testTimerRejectsInvalidDuration() async {
        let rec = TimerRecorder()
        let exec = makeExecutor(FakeEventKit(), rec)
        let out = await exec.execute(step: step("timer.local", ["durationSeconds": "0"]), token: token())
        XCTAssertFalse(out.ok)
        XCTAssertTrue(rec.calls.isEmpty)
    }

    func testReminderCreateSuccessAndFailure() async {
        let ek = FakeEventKit()
        let exec = makeExecutor(ek, TimerRecorder())
        let ok = await exec.execute(step: step("reminder.local.create",
            ["title": "交报告", "resolvedDate": "2026-06-26T09:00:00Z", "timezone": "Asia/Shanghai"]), token: token())
        XCTAssertTrue(ok.ok)
        XCTAssertTrue(ok.output.contains("交报告"))
        let titles = await ek.reminderTitles
        XCTAssertEqual(titles, ["交报告"])

        await ek.setFailReminder(true)
        let fail = await exec.execute(step: step("reminders.create",
            ["title": "x", "resolvedDate": "2026-06-26T09:00:00Z", "timezone": "Asia/Shanghai"]), token: token())
        XCTAssertFalse(fail.ok)
        XCTAssertEqual(fail.error, "提醒权限未授予")
    }

    func testCalendarCreateAndReads() async {
        let ek = FakeEventKit()
        let exec = makeExecutor(ek, TimerRecorder())
        let cal = await exec.execute(step: step("calendar.event.create",
            ["title": "周会", "startDate": "2026-06-26T09:00:00Z"]), token: token())
        XCTAssertTrue(cal.ok)
        let calTitles = await ek.calendarTitles
        XCTAssertEqual(calTitles, ["周会"])

        let rRead = await exec.execute(step: step("reminders.read"), token: token())
        XCTAssertTrue(rRead.output.contains("交报告"))
        let cRead = await exec.execute(step: step("calendar.events.read"), token: token())
        XCTAssertTrue(cRead.output.contains("周会"))
    }
}

// MARK: - Validator accepts new capabilities without weakening escape defenses

final class P2DecisionValidatorTests: XCTestCase {
    private let caps = CapabilityCatalogSnapshot(capabilities: CapabilityCatalog.all)

    private func planJSON(_ capabilityID: String, _ args: [String: String]) -> String {
        let argPairs = args.map { "\"\($0.key)\":\"\($0.value)\"" }.joined(separator: ",")
        return """
        {"schemaVersion":1,"kind":"proposePlan","plan":{"goal":"g","steps":[{"id":"s1","description":"d","capabilityID":"\(capabilityID)","arguments":{\(argPairs)}}]}}
        """
    }
    private func accepts(_ cap: String, _ args: [String: String]) -> Bool {
        (try? StructuredDecisionValidator.validate(raw: planJSON(cap, args), availableCapabilities: caps)) != nil
    }

    func testAcceptsValidNewCapabilities() {
        XCTAssertTrue(accepts("network.fetch", ["url": "https://example.com"]))
        XCTAssertTrue(accepts("network.search", ["query": "swift concurrency"]))
        XCTAssertTrue(accepts("filesystem.workspace.read", ["path": "notes/today.md"]))
        XCTAssertTrue(accepts("filesystem.workspace.write", ["path": "out/log.txt", "content": "hello ../ ~ /etc/ ok"]))
        XCTAssertTrue(accepts("calendar.event.create", ["title": "周会", "startDate": "2026-06-26T09:00:00Z"]))
    }

    func testRejectsUnsafeArguments() {
        XCTAssertFalse(accepts("network.fetch", ["url": "http://example.com"]))       // not https
        XCTAssertFalse(accepts("network.fetch", ["url": "https://127.0.0.1"]))        // private host
        XCTAssertFalse(accepts("filesystem.workspace.read", ["path": "../escape"]))   // traversal
        XCTAssertFalse(accepts("filesystem.workspace.read", ["path": "/etc/passwd"])) // absolute
        XCTAssertFalse(accepts("calendar.event.create", ["title": "x"]))             // missing startDate
    }

    func testRegressionExistingCapabilitiesStillValidate() {
        XCTAssertTrue(accepts("reminder.local.create",
            ["title": "交报告", "resolvedDate": "2026-06-26T09:00:00Z", "timezone": "Asia/Shanghai"]))
        XCTAssertTrue(accepts("timer.local", ["durationSeconds": "60"]))
        XCTAssertFalse(accepts("timer.local", ["durationSeconds": "-5"]))
    }
}
