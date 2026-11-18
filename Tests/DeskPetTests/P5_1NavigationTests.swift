import XCTest
import Foundation
@testable import DeskPet

@MainActor
final class P5_1NavigationTests: XCTestCase {

    func testAllSectionsHaveTitleAndSymbol() {
        for section in AppSection.allCases {
            XCTAssertFalse(section.title.isEmpty)
            XCTAssertFalse(section.symbol.isEmpty)
            XCTAssertEqual(AppSection(rawValue: section.rawValue), section)
        }
    }

    func testExpectedSectionsExistAndDataMovedIntoSettings() {
        // P0-P3 console exposes product sections for pet, AI, and system controls.
        XCTAssertEqual(AppSection.allCases.map(\.rawValue),
                       ["chat", "today", "companion", "focus", "memory", "schedule",
                        "tasks", "models", "providers", "toolPermissions",
                        "privacy", "appearance", "advanced"])
    }

    private func makeModel() -> AppModel {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("tasks-\(UUID().uuidString).json")
        return AppModel(store: TaskStore(fileURL: url))
    }

    func testEmptyStateConditionWhenNoTasks() {
        let model = makeModel()
        XCTAssertTrue(model.tasks.isEmpty)        // TodayView shows the empty state in this condition
    }

    func testAddTaskLeavesEmptyState() {
        let model = makeModel()
        model.add(PetTask(title: "复习"))
        XCTAssertFalse(model.tasks.isEmpty)
        XCTAssertEqual(model.tasks.count, 1)
    }

    func testCompleteFiresCompletionCallbackOnce() {
        let model = makeModel()
        var fired = 0
        model.onTaskCompleted = { fired += 1 }
        model.add(PetTask(title: "写周报"))
        let task = model.tasks[0]
        model.toggleDone(task)                    // -> done, fires once
        XCTAssertEqual(fired, 1)
        model.toggleDone(model.tasks[0])          // -> undone, no fire
        XCTAssertEqual(fired, 1)
    }

    func testProgressCountsAreReal() {
        let model = makeModel()
        model.add(PetTask(title: "a"))
        model.add(PetTask(title: "b"))
        model.toggleDone(model.tasks[0])
        let done = model.tasks.filter(\.done).count
        XCTAssertEqual(done, 1)
        XCTAssertEqual(model.tasks.count, 2)      // progress = 1/2, not fabricated
    }
}
