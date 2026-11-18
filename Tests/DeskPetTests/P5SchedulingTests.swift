import XCTest
import Foundation
@testable import DeskPet
@testable import PetAgentRuntime
@testable import PetBrainCore
@testable import AICore

// P5 — scheduled/recurring tasks: pure schedule math, the scheduler, the autonomy gate, and the
// schedule.create tool + validator.

// MARK: - Pure schedule math (AICore)

final class ScheduleTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000_000)

    func testOneShotNextFire() {
        XCTAssertEqual(Schedule.oneShot(t0.addingTimeInterval(60)).nextFire(after: t0), t0.addingTimeInterval(60))
        XCTAssertNil(Schedule.oneShot(t0.addingTimeInterval(-60)).nextFire(after: t0))   // past → never
    }
    func testEverySecondsNextFire() {
        XCTAssertEqual(Schedule.everySeconds(90).nextFire(after: t0), t0.addingTimeInterval(90))
    }
    func testDailyAtIsInFuture() {
        let next = Schedule.dailyAt(hour: 9, minute: 30).nextFire(after: t0)
        XCTAssertNotNil(next)
        XCTAssertGreaterThan(next!, t0)
    }
    func testDueSelectsArrivedEnabled() {
        let due = ScheduledTask(title: "a", prompt: "p", schedule: .everySeconds(60),
                                createdAt: t0, nextFireAt: t0)
        let future = ScheduledTask(title: "b", prompt: "p", schedule: .everySeconds(60),
                                   createdAt: t0, nextFireAt: t0.addingTimeInterval(100))
        var off = due; off.enabled = false
        let picked = ScheduleCalculator.due([due, future, off], at: t0.addingTimeInterval(1))
        XCTAssertEqual(picked.map(\.id), [due.id])
    }
    func testRecomputeRecurringVsOneShot() {
        let recurring = ScheduledTask(title: "a", prompt: "p", schedule: .everySeconds(60), createdAt: t0)
        let r = ScheduleCalculator.recompute(recurring, firedAt: t0)
        XCTAssertEqual(r.nextFireAt, t0.addingTimeInterval(60))
        XCTAssertTrue(r.enabled)

        let once = ScheduledTask(title: "b", prompt: "p", schedule: .oneShot(t0), createdAt: t0, nextFireAt: t0)
        let o = ScheduleCalculator.recompute(once, firedAt: t0)
        XCTAssertNil(o.nextFireAt)
        XCTAssertFalse(o.enabled)                       // exhausted one-shot disables itself
    }
    func testRealignSnapsOverdueRecurringToFuture() {
        let overdue = ScheduledTask(title: "a", prompt: "p", schedule: .everySeconds(60),
                                    createdAt: t0, nextFireAt: t0.addingTimeInterval(-500))
        let now = t0.addingTimeInterval(1000)
        let realigned = ScheduleCalculator.realignOnLaunch(overdue, now: now)
        XCTAssertGreaterThan(realigned.nextFireAt!, now)    // no backlog replay
    }
    func testMissedFirePolicyPerKind() {
        XCTAssertEqual(Schedule.oneShot(t0).missedFirePolicy, .catchUpOnce)
        XCTAssertEqual(Schedule.everySeconds(60).missedFirePolicy, .skipToNext)
        XCTAssertEqual(Schedule.dailyAt(hour: 9, minute: 0).missedFirePolicy, .skipToNext)
    }
    func testRealignAfterWakeMatchesLaunchPolicy() {
        let now = t0.addingTimeInterval(1000)
        let overdueRecurring = ScheduledTask(title: "a", prompt: "p", schedule: .everySeconds(60),
                                             createdAt: t0, nextFireAt: t0.addingTimeInterval(-500))
        let woken = ScheduleCalculator.realignAfterWake(overdueRecurring, now: now)
        XCTAssertGreaterThan(woken.nextFireAt!, now)   // stale slot skipped, no fire
        XCTAssertTrue(ScheduleCalculator.due([woken], at: now).isEmpty)

        let overdueOnce = ScheduledTask(title: "b", prompt: "p", schedule: .oneShot(t0.addingTimeInterval(10)),
                                        createdAt: t0, nextFireAt: t0.addingTimeInterval(10))
        let wokenOnce = ScheduleCalculator.realignAfterWake(overdueOnce, now: now)
        XCTAssertEqual(ScheduleCalculator.due([wokenOnce], at: now).map(\.id), [overdueOnce.id]) // catch-up once
    }
}

// MARK: - Scheduler

@MainActor
final class TaskSchedulerTests: XCTestCase {
    private func tmpStore() -> ScheduledTaskStore {
        ScheduledTaskStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("sched-\(UUID().uuidString).json"))
    }
    private let base = Date(timeIntervalSince1970: 2_000_000)

    func testFiresDueTaskAndRecomputes() async {
        let now = base
        let sched = TaskScheduler(store: tmpStore(), now: { now })
        var fired: [String] = []
        sched.runner = { task in fired.append(task.prompt); return "done" }
        var task = ScheduledTask(title: "t", prompt: "喝水", schedule: .everySeconds(60), createdAt: now)
        task.nextFireAt = now
        sched.add(task)

        await sched.fireDueNow()

        XCTAssertEqual(fired, ["喝水"])
        XCTAssertEqual(sched.tasks.first?.lastResult, "done")
        XCTAssertEqual(sched.tasks.first?.nextFireAt, now.addingTimeInterval(60))
    }

    func testOneShotFiresOnceThenDisabled() async {
        let now = base
        let sched = TaskScheduler(store: tmpStore(), now: { now })
        var count = 0
        sched.runner = { _ in count += 1; return "" }
        var task = ScheduledTask(title: "t", prompt: "p", schedule: .oneShot(now), createdAt: now)
        task.nextFireAt = now
        sched.add(task)

        await sched.fireDueNow()
        await sched.fireDueNow()                        // no longer due/enabled

        XCTAssertEqual(count, 1)
        XCTAssertFalse(sched.tasks.first!.enabled)
    }

    func testLaunchRealignsOverdueRecurring() throws {
        let store = tmpStore()
        let past = base.addingTimeInterval(-1000)
        var task = ScheduledTask(title: "t", prompt: "p", schedule: .everySeconds(60), createdAt: past)
        task.nextFireAt = past
        try store.save([task])
        let now = base
        let sched = TaskScheduler(store: store, now: { now })
        XCTAssertGreaterThan(sched.tasks.first!.nextFireAt!, now)
    }

    func testResumeAfterWakeSkipsStaleRecurringKeepsOneShot() async {
        var now = base
        let sched = TaskScheduler(store: tmpStore(), now: { now })
        var recurring = ScheduledTask(title: "r", prompt: "p", schedule: .everySeconds(60), createdAt: base)
        recurring.nextFireAt = base.addingTimeInterval(-500)   // went stale during sleep
        let once = ScheduledTask(title: "o", prompt: "p", schedule: .oneShot(base.addingTimeInterval(10)),
                                 createdAt: base, nextFireAt: base.addingTimeInterval(10))
        sched.add(recurring); sched.add(once)
        now = base.addingTimeInterval(1000)                    // wake much later
        sched.realignForWake()                                 // sync seam, no timer
        XCTAssertTrue(ScheduleCalculator.due(sched.tasks.filter { $0.title == "r" }, at: now).isEmpty)
        XCTAssertEqual(ScheduleCalculator.due(sched.tasks.filter { $0.title == "o" }, at: now).count, 1)
    }
}

// MARK: - Autonomy gate

private func gateKind(_ o: GateOutcome) -> String {
    switch o { case .granted: return "granted"; case .denied: return "denied"; case .askUser: return "askUser" }
}

final class AutonomyGateTests: XCTestCase {
    private let p2 = "reminder.local.create"
    private let p2b = "calendar.event.create"
    private let p3 = "network.fetch"

    func testNotifyOnlyDefersP1Plus() async {
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in .allowSession })
        await gate.setAutonomousRun(.notifyOnly)
        let out = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        XCTAssertEqual(gateKind(out), "askUser")        // not executed, even though approver would allow
    }

    func testPreauthorizedGrantsOnlyListedCaps() async {
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in .deny })
        await gate.setAutonomousRun(.preauthorized([p2]))
        let granted = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        let deferred = await gate.evaluate(capabilityID: p2b, reason: "r", taskID: UUID())
        XCTAssertEqual(gateKind(granted), "granted")
        XCTAssertEqual(gateKind(deferred), "askUser")   // outside the pre-authorized set → deferred
    }

    func testPreauthorizedStillCannotExceedTier() async {
        // App Store tier hard-caps at P2; pre-authorizing a P3 cap cannot escalate.
        let gate = BrokerCapabilityGate(tier: .appStore)
        await gate.setAutonomousRun(.preauthorized([p3]))
        let out = await gate.evaluate(capabilityID: p3, reason: "r", taskID: UUID())
        XCTAssertEqual(gateKind(out), "denied")
    }

    func testClearingAutonomyRestoresInteractive() async {
        let gate = BrokerCapabilityGate(tier: .developerID, approver: { _, _, _ in .allowOnce })
        await gate.setAutonomousRun(.notifyOnly)
        await gate.setAutonomousRun(nil)
        let out = await gate.evaluate(capabilityID: p2, reason: "r", taskID: UUID())
        XCTAssertEqual(gateKind(out), "granted")        // interactive approver path resumes
    }
}

// MARK: - schedule.create tool + validator

private struct StubEK: EventKitAccess {
    func createReminder(title: String, due: Date?, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "x")) }
    func createCalendarEvent(title: String, start: Date, end: Date, notes: String?) async -> Result<String, ToolFailure> { .failure(ToolFailure(message: "x")) }
    func readReminders(limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "x")) }
    func readCalendarEvents(daysAhead: Int, limit: Int) async -> Result<[String], ToolFailure> { .failure(ToolFailure(message: "x")) }
}
private actor TaskBox {
    private(set) var tasks: [ScheduledTask] = []
    func record(_ t: ScheduledTask) -> Bool { tasks.append(t); return true }
    func all() -> [ScheduledTask] { tasks }
}

final class ScheduleCreateToolTests: XCTestCase {
    func testToolCreatesNotifyOnlyAgentTask() async {
        let box = TaskBox()
        let exec = InProcessToolExecutor(eventKit: StubEK(), scheduleTimer: { _, _ in },
                                         scheduleCreate: { task in await box.record(task) })
        let step = AgentPlanStep(description: "d", capabilityID: "schedule.create",
                                 params: ["title": "喝水", "prompt": "提醒我喝水",
                                          "scheduleKind": "dailyAt", "hour": "9", "minute": "0"])
        let out = await exec.execute(step: step, token: CapabilityToken(raw: "t", taskID: UUID(), expiresAt: .distantFuture))
        let created = await box.all()
        XCTAssertTrue(out.ok)
        XCTAssertEqual(created.count, 1)
        XCTAssertEqual(created.first?.source, .agent)
        XCTAssertEqual(created.first?.autonomy, .notifyOnly)     // agent can never self-pre-authorize
    }
}

final class ScheduleCreateValidatorTests: XCTestCase {
    private let caps = CapabilityCatalogSnapshot(capabilities: CapabilityCatalog.all)
    private func accepts(_ args: [String: String]) -> Bool {
        let pairs = args.map { "\"\($0.key)\":\"\($0.value)\"" }.joined(separator: ",")
        let json = "{\"schemaVersion\":1,\"kind\":\"proposePlan\",\"plan\":{\"goal\":\"g\",\"steps\":[{\"id\":\"s1\",\"description\":\"d\",\"capabilityID\":\"schedule.create\",\"arguments\":{\(pairs)}}]}}"
        return (try? StructuredDecisionValidator.validate(raw: json, availableCapabilities: caps)) != nil
    }

    func testAcceptsValid() {
        XCTAssertTrue(accepts(["title": "喝水", "prompt": "提醒喝水", "scheduleKind": "everySeconds", "seconds": "3600"]))
        XCTAssertTrue(accepts(["title": "晨会", "prompt": "看日历", "scheduleKind": "dailyAt", "hour": "9", "minute": "0"]))
    }
    func testRejectsInvalid() {
        XCTAssertFalse(accepts(["title": "x", "prompt": "p", "scheduleKind": "everySeconds"]))         // missing seconds
        XCTAssertFalse(accepts(["title": "x", "prompt": "p", "scheduleKind": "dailyAt", "hour": "99", "minute": "0"]))  // bad hour
        XCTAssertFalse(accepts(["title": "x", "prompt": "p", "scheduleKind": "bogus"]))                // bad kind
    }
}
