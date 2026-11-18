import XCTest
import Foundation
@testable import DeskPet

final class TaskDraftParserTests: XCTestCase {

    private func cal() -> Calendar {
        var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Asia/Shanghai")!; return c
    }

    func testParsesRoundsMinutesDueAndTitle() {
        let now = cal().date(from: DateComponents(year: 2026, month: 6, day: 17, hour: 10))!
        let d = TaskDraftParser.parse("明晚前复习积分，两轮45分钟", now: now, calendar: cal())
        XCTAssertEqual(d.focusRounds, 2)
        XCTAssertEqual(d.estimatedMinutes, 45)
        XCTAssertEqual(d.title, "复习积分")
        let comps = cal().dateComponents([.day, .hour], from: d.due!)
        XCTAssertEqual(comps.day, 18)     // tomorrow
        XCTAssertEqual(comps.hour, 21)    // 晚 → 21:00
    }

    func testArabicAndAfternoonTime() {
        let now = cal().date(from: DateComponents(year: 2026, month: 6, day: 17, hour: 10))!
        let d = TaskDraftParser.parse("明天下午写周报，1轮25分钟", now: now, calendar: cal())
        XCTAssertEqual(d.focusRounds, 1)
        XCTAssertEqual(d.estimatedMinutes, 25)
        XCTAssertEqual(d.title, "写周报")
        XCTAssertEqual(cal().component(.hour, from: d.due!), 15)
    }

    func testPriorityKeyword() {
        let d = TaskDraftParser.parse("紧急修复登录bug", calendar: cal())
        XCTAssertEqual(d.priority, .high)
        XCTAssertEqual(d.title, "修复登录bug")
    }

    func testNoTemporalLeavesTitleIntact() {
        let d = TaskDraftParser.parse("看一章书", calendar: cal())
        XCTAssertNil(d.due)
        XCTAssertEqual(d.title, "看一章书")
    }
}

final class FocusMachineTests: XCTestCase {

    func testPomodoroWorkThenBreakThenWork() {
        var m = FocusMachine(mode: .pomodoro(work: 1, brk: 1, rounds: 2, longBreak: 2)) // minutes
        _ = m.start()
        XCTAssertEqual(m.phase, .work)
        let e1 = m.tick(seconds: 60)
        XCTAssertTrue(e1.contains(.roundCompleted(1)))
        XCTAssertTrue(e1.contains(.phaseChanged(.shortBreak)))
        XCTAssertEqual(m.phase, .shortBreak)
        let e2 = m.tick(seconds: 60)
        XCTAssertTrue(e2.contains(.phaseChanged(.work)))
        XCTAssertEqual(m.phase, .work)
    }

    func testFinalRoundGoesToLongBreakThenFinished() {
        var m = FocusMachine(mode: .pomodoro(work: 1, brk: 1, rounds: 1, longBreak: 1))
        _ = m.start()
        let e1 = m.tick(seconds: 60)
        XCTAssertTrue(e1.contains(.phaseChanged(.longBreak)))   // last round → long break
        let e2 = m.tick(seconds: 60)
        XCTAssertTrue(e2.contains(.finished))
        XCTAssertEqual(m.phase, .finished)
    }

    func testTaskDrivenAsksButDoesNotForceStop() {
        var m = FocusMachine(mode: .taskDriven(targetWork: 1)) // 1 min target
        _ = m.start()
        let e = m.tick(seconds: 60)
        XCTAssertTrue(e.contains(.askContinue))
        XCTAssertEqual(m.phase, .work)          // never auto-stops (doc §9.4)
        let more = m.tick(seconds: 30)
        XCTAssertTrue(more.isEmpty)             // keeps recording, asks only once
        XCTAssertTrue(m.isOvertime)
    }
}

@MainActor
final class TaskStoreTests: XCTestCase {

    func testRoundTripPersistsTasks() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-test-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let store = TaskStore(fileURL: tmp)
        var t = PetTask(title: "测试任务")
        t.priority = .high; t.estimatedMinutes = 45; t.focusRounds = 2
        try store.save([t])

        let loaded = TaskStore(fileURL: tmp).load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.title, "测试任务")
        XCTAssertEqual(loaded.first?.priority, .high)
        XCTAssertEqual(loaded.first?.focusRounds, 2)
    }

    func testTopOpenTasksOrdersHighPriorityFirst() {
        let store = TaskStore(fileURL: FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-top-\(UUID().uuidString).json"))
        let model = AppModel(store: store)
        var low = PetTask(title: "低"); low.priority = .low
        var high = PetTask(title: "高"); high.priority = .high
        model.add(low); model.add(high)
        XCTAssertEqual(model.topOpenTasks.first?.title, "高")
    }
}
