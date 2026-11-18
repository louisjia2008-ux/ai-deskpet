import XCTest
import Foundation
@testable import DeskPet
@testable import AICore

@MainActor
final class P6MemoryPolicyTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    func testExplicitLongTermLowRiskPreferenceAutoCommits() {
        let decision = MemoryPolicyEngine.decide(candidate: candidate("以后默认用中文回复我。", scope: .semantic, explicit: true),
                                                 now: now)
        guard case .autoCommit = decision else { return XCTFail("expected autoCommit, got \(decision)") }
    }

    func testDefaultChineseBecomesActiveSemanticThroughRepository() {
        let model = makeModel()
        let decision = model.ingest(candidate("以后默认用中文回复我。", key: "preference.default_language", scope: .semantic, explicit: true),
                                    now: now)
        guard case .autoCommit = decision else { return XCTFail("expected autoCommit") }
        XCTAssertEqual(model.rememberedItems.first?.state, .active)
        XCTAssertEqual(model.rememberedItems.first?.scope, .semantic)
    }

    func testRunTestsPreferenceBecomesProcedural() {
        let model = makeModel()
        _ = model.ingest(candidate("修改代码后一定运行测试。", key: "procedure.code.run_tests_after_changes", scope: .procedural, explicit: true),
                         now: now)
        XCTAssertEqual(model.rememberedItems.first?.scope, .procedural)
    }

    func testTransientSeatPreferenceDoesNotBecomeLongTerm() {
        let decision = MemoryPolicyEngine.decide(candidate: candidate("这次查询机票我要靠窗。", scope: .semantic),
                                                 now: now)
        guard case .keepEphemeral(let scope, _, _) = decision else {
            return XCTFail("expected keepEphemeral, got \(decision)")
        }
        XCTAssertEqual(scope, .session)
    }

    func testRepeatedEvidenceUpgradesAfterThreshold() {
        let key = "preference.flight.seat"
        let first = item("靠窗", key: key, session: UUID(), evidence: 1, state: .observed)
        let second = item("靠窗", key: key, session: UUID(), evidence: 1, state: .observed)
        let third = MemoryCandidate(proposedScope: .semantic,
                                    canonicalKey: key,
                                    summary: "坐飞机优先靠窗",
                                    normalizedValue: "靠窗",
                                    confidence: 0.9,
                                    sourceReference: .init(conversationID: UUID()),
                                    sourceKind: .repeatedUserBehavior)
        let decision = MemoryPolicyEngine.decide(candidate: third, existing: [first, second], now: now)
        guard case .autoCommit = decision else { return XCTFail("expected autoCommit, got \(decision)") }
    }

    func testDateAndTimeRequestsAreIgnored() {
        for text in ["今天几号？", "现在几点？", "What is the current local date and time?", "告诉我当前日期。"] {
            let decision = MemoryPolicyEngine.decide(candidate: candidate(text), now: now)
            guard case .ignore = decision else { return XCTFail("expected ignore for \(text), got \(decision)") }
        }
    }

    func testOrdinaryTaskPromptAssistantContentAndToolArgumentsAreIgnored() {
        let task = MemoryPolicyEngine.decide(candidate: candidate("查询今天日历"), now: now)
        let assistant = MemoryPolicyEngine.decide(candidate: candidate("你喜欢蓝色", authoredByAssistant: true), now: now)
        var toolArgs = candidate(#"{"include_all_day":true}"#)
        toolArgs.rawCategoryHint = "toolArguments"
        let args = MemoryPolicyEngine.decide(candidate: toolArgs, now: now)
        for decision in [task, assistant, args] {
            guard case .ignore = decision else { return XCTFail("expected ignore, got \(decision)") }
        }
    }

    func testSecretsAreRejectedEvenWhenExplicit() {
        for text in ["请记住我的 API Key 是 sk-abc123456", "password=secret123", "OTP 是 123456"] {
            let decision = MemoryPolicyEngine.decide(candidate: candidate(text, explicit: true), now: now)
            guard case .reject = decision else { return XCTFail("expected reject, got \(decision)") }
        }
    }

    func testSensitiveMemoryRequiresConfirmation() {
        let decision = MemoryPolicyEngine.decide(candidate: candidate("我的健康状态需要保密", sensitivity: .sensitive, explicit: true),
                                                 now: now)
        guard case .requireConfirmation = decision else { return XCTFail("expected requireConfirmation, got \(decision)") }
    }

    func testConflictingValueDoesNotCreateTwoActiveMemories() {
        let existing = item("默认中文", key: "preference.default_language", value: "zh", state: .active)
        let ambiguous = candidate("默认用英文回复", key: "preference.default_language", value: "en", explicit: false)
        let decision = MemoryPolicyEngine.decide(candidate: ambiguous, existing: [existing], now: now)
        guard case .requireConfirmation = decision else { return XCTFail("expected requireConfirmation, got \(decision)") }

        let model = makeModel()
        XCTAssertTrue(model.add(existing))
        _ = model.ingest(candidate("以后默认用英文回复我。", key: "preference.default_language", value: "en", explicit: true),
                         now: now)
        XCTAssertEqual(model.items.filter { $0.canonicalKey == "preference.default_language" && $0.state == .active }.count, 1)
        XCTAssertEqual(model.items.first { $0.normalizedValue == "zh" }?.state, .superseded)
    }

    private func candidate(_ text: String,
                           key: String? = nil,
                           value: String? = nil,
                           scope: MemoryScope = .semantic,
                           sensitivity: MemorySensitivity = .ordinary,
                           explicit: Bool = false,
                           authoredByAssistant: Bool = false) -> MemoryCandidate {
        MemoryCandidate(proposedScope: scope,
                        canonicalKey: key,
                        summary: text,
                        normalizedValue: value,
                        confidence: 0.9,
                        sensitivityHint: sensitivity,
                        sourceReference: .init(conversationID: UUID()),
                        sourceKind: explicit ? .explicitUserStatement : .repeatedUserBehavior,
                        explicitlyRequestedByUser: explicit,
                        authoredByAssistant: authoredByAssistant)
    }
}

@MainActor
final class P6MemoryRepositoryTests: XCTestCase {
    func testForgetRemovesMemoryFromRetrieval() {
        let model = makeModel()
        model.add(MemoryItem(text: "以后默认用中文回复我。", category: .preference, source: .explicit,
                             canonicalKey: "preference.default_language", scope: .semantic,
                             state: .active, normalizedValue: "zh"))
        let item = model.items[0]
        XCTAssertFalse(model.activeHints(forCloud: false, taskText: "回复语言").isEmpty)
        model.forget(item)
        XCTAssertTrue(model.activeHints(forCloud: false, taskText: "回复语言").isEmpty)
    }

    func testUndoAutoLearnedArchivesRecord() {
        let model = makeModel()
        _ = model.ingest(MemoryCandidate(proposedScope: .semantic,
                                         canonicalKey: "preference.default_language",
                                         summary: "以后默认用中文回复我。",
                                         normalizedValue: "zh",
                                         sourceKind: .explicitUserStatement,
                                         explicitlyRequestedByUser: true))
        guard let item = model.items.first else { return XCTFail("missing item") }
        var auto = item
        auto.source = .auto
        model.update(auto)
        model.undoAutoLearned(auto)
        XCTAssertEqual(model.items.first?.state, .superseded)
    }

    func testDisabledMemorySkipsLongTermButAllowsWorkingMemory() {
        let model = makeModel()
        model.setMemoryEnabled(false)
        let longTerm = model.ingest(MemoryCandidate(proposedScope: .semantic,
                                                    summary: "以后默认用中文回复我。",
                                                    sourceKind: .explicitUserStatement,
                                                    explicitlyRequestedByUser: true))
        guard case .ignore = longTerm else { return XCTFail("expected ignore") }
        let working = model.ingest(MemoryCandidate(proposedScope: .working,
                                                   summary: "本次出发地是 SFO",
                                                   normalizedValue: "SFO"))
        guard case .keepEphemeral(let scope, _, _) = working else { return XCTFail("expected ephemeral") }
        XCTAssertEqual(scope, .working)
        XCTAssertEqual(model.shortTermContextItems.count, 1)
    }

    func testMigrationIsIdempotentAndClassifiesDateTimeJunk() {
        let legacy = MemoryItem(text: "告诉我当前日期和时间。", category: .usageHabit, source: .suggested,
                                confirmed: false, schemaVersion: 1)
        let once = MemoryLegacyMigrator.migrate([legacy])
        let twice = MemoryLegacyMigrator.migrate(once)
        XCTAssertEqual(once, twice)
        XCTAssertEqual(twice.first?.state, .ignored)
    }

    func testCorruptLegacyItemDoesNotBlockRemainingRecords() throws {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("deskpet-p6-corrupt-\(UUID().uuidString).json")
        let validID = UUID()
        let json = """
        [
          {"id":"\(validID.uuidString)","text":"以后默认用中文回复我。","category":"preference","source":"explicit","confirmed":true,"createdAt":"2026-01-01T00:00:00Z"},
          {"id": 42, "text": ["broken"]}
        ]
        """
        try Data(json.utf8).write(to: url)
        let store = MemoryStore(fileURL: url)
        let loaded = store.load()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertFalse(store.lastDiagnostics.isEmpty)
    }
}

final class P6MemoryRetrievalTests: XCTestCase {
    func testRetrievalFiltersAndOrdersContext() {
        let conversationID = UUID()
        let taskID = UUID()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let working = item("本次出发地 SFO", key: "travel.origin", scope: .working,
                           refs: [.init(conversationID: conversationID, taskID: taskID)], updatedAt: now)
        let procedural = item("查机票优先比较直飞和总时长", key: "procedure.travel.compare",
                              scope: .procedural, updatedAt: now.addingTimeInterval(-100))
        let semantic = item("默认用中文回复", key: "preference.default_language",
                            scope: .semantic, updatedAt: now.addingTimeInterval(-200))
        var expired = item("过期", key: "expired", scope: .semantic, updatedAt: now)
        expired.expiresAt = now.addingTimeInterval(-1)
        var pending = item("待确认", key: "pending", scope: .semantic, state: .pendingConfirmation)
        pending.confirmed = false
        var superseded = item("旧值", key: "old", scope: .semantic, state: .superseded)
        superseded.confirmed = false
        let selected = MemoryContextBuilder.build(items: [semantic, pending, working, expired, superseded, procedural],
                                                  taskText: "查询机票并比较直飞",
                                                  conversationID: conversationID,
                                                  taskID: taskID,
                                                  now: now,
                                                  budget: .init(maxItems: 3, maxCharacters: 200))
        XCTAssertEqual(selected.map(\.canonicalKey), ["travel.origin", "procedure.travel.compare", "preference.default_language"])
    }

    func testSessionAndTaskIsolationAndBudget() {
        let conversationID = UUID()
        let taskID = UUID()
        let otherConversation = item("其他会话", key: "session.other", scope: .session,
                                     refs: [.init(conversationID: UUID())])
        let session = item("本会话第二个方案", key: "session.current", scope: .session,
                           refs: [.init(conversationID: conversationID)])
        let otherTask = item("其他任务 working", key: "working.other", scope: .working,
                             refs: [.init(conversationID: conversationID, taskID: UUID())])
        let working = item("本任务 working", key: "working.current", scope: .working,
                           refs: [.init(conversationID: conversationID, taskID: taskID)])
        let selected = MemoryContextBuilder.build(items: [otherConversation, session, otherTask, working],
                                                  taskText: "方案",
                                                  conversationID: conversationID,
                                                  taskID: taskID,
                                                  budget: .init(maxItems: 1, maxCharacters: 30))
        XCTAssertEqual(selected.map(\.canonicalKey), ["working.current"])
    }
}

@MainActor
private func makeModel() -> MemoryModel {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("deskpet-p6-memory-\(UUID().uuidString).json")
    return MemoryModel(store: MemoryStore(fileURL: url))
}

private func item(_ text: String,
                  key: String,
                  value: String? = nil,
                  scope: MemoryScope = .semantic,
                  session: UUID? = nil,
                  evidence: Int = 1,
                  state: MemoryState = .active,
                  refs: [MemorySourceReference] = [],
                  updatedAt: Date = Date()) -> MemoryItem {
    var references = refs
    if let session { references = [.init(conversationID: session)] }
    return MemoryItem(text: text,
                      category: MemoryLegacyMapper.category(for: scope),
                      source: .explicit,
                      confirmed: state == .active,
                      createdAt: updatedAt,
                      canonicalKey: key,
                      scope: scope,
                      state: state,
                      normalizedValue: value ?? text,
                      confidence: 0.9,
                      evidenceCount: evidence,
                      sourceReferences: references,
                      updatedAt: updatedAt)
}
