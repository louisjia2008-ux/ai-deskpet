import XCTest
import Foundation
@testable import PetBrainCore
@testable import PetAgentRuntime
@testable import AICore

final class P3AssistantSeamTests: XCTestCase {

    func testAssistantUtteranceMapsToCapability() {
        XCTAssertEqual(AssistantCapabilityMap.capability(for: "帮我设个提醒")?.capability, "reminders.create")
        XCTAssertEqual(AssistantCapabilityMap.capability(for: "在日历加个日程")?.capability, "calendar.event.create")
        XCTAssertEqual(AssistantCapabilityMap.capability(for: "打开 Xcode")?.capability, "application.launch")
        XCTAssertEqual(AssistantCapabilityMap.capability(for: "计时 25 分钟")?.capability, "timer.local")
        XCTAssertEqual(AssistantCapabilityMap.capability(for: "告诉我现在的本地日期和时间。")?.capability, "get_current_datetime")
        XCTAssertNil(AssistantCapabilityMap.capability(for: "今天天气怎么样"))
    }

    func testMappedCapabilitiesAreRealCatalogEntries() {
        // The declared capability must exist in the broker catalog (so it can actually be evaluated).
        for text in ["设个提醒", "加日历", "打开应用", "番茄计时", "当前日期和时间"] {
            if let req = AssistantCapabilityMap.capability(for: text) {
                XCTAssertNotNil(CapabilityCatalog.lookup(req.capability))
            }
        }
    }

    func testDateTimeIntentNormalizerCoversSharedChineseAndEnglishPhrases() {
        let phrases = [
            "今天几号",
            "今天是几号",
            "今天什么日期",
            "今天是哪一天",
            "当前日期",
            "现在日期",
            "告诉我今天的日期",
            "今天星期几",
            "今天周几",
            "现在几点",
            "当前时间",
            "本地时间",
            "现在是什么时间",
            "当前日期和时间",
            "本地日期和时间",
            "现在的日期时间",
            "今天几号几点",
            "what is today's date",
            "what is today’s date",
            "what day is it today",
            "what time is it",
            "date and time",
            "現在幾點？",
            "今天是幾號？"
        ]

        for phrase in phrases {
            XCTAssertEqual(DateTimeIntentNormalizer.intent(for: phrase), .currentDateTime, phrase)
            XCTAssertEqual(AssistantCapabilityMap.capability(for: phrase)?.capability,
                           "get_current_datetime",
                           phrase)
            XCTAssertEqual(RuntimeRequestPreparer.prepare(userText: phrase).executionMode,
                           .boundedToolLoop,
                           phrase)
        }
    }

    func testDateTimeIntentNormalizerAvoidsDateEditingFalsePositives() {
        let phrases = [
            "帮我修改这封邮件的日期格式",
            "帮我把邮件里的日期格式改成 YYYY-MM-DD。",
            "总结这份带日期的文档",
            "format date as YYYY-MM-DD"
        ]

        for phrase in phrases {
            XCTAssertNil(DateTimeIntentNormalizer.intent(for: phrase), phrase)
            XCTAssertNil(AssistantCapabilityMap.capability(for: phrase), phrase)
            XCTAssertEqual(RuntimeRequestPreparer.prepare(userText: phrase).executionMode,
                           .conversation,
                           phrase)
        }
    }

    func testContextualTimeFollowUpsInheritPreviousDateTimeCapability() {
        let context = ConversationIntentContext(
            conversationID: UUID(),
            recentUserGoal: "现在几点？",
            previousInferredCapabilities: [.currentDateTime],
            previousSuccessfulToolIDs: ["get_current_datetime"],
            previousOutcomeStatus: .succeeded,
            previousCompletedAt: Date(),
            recentAssistantCategory: "activity:succeeded"
        )
        let phrases = [
            "具体到秒",
            "再精确一点",
            "刷新一下",
            "用 24 小时制",
            "带上星期几",
            "what about the seconds",
            "down to the second",
            "what about now"
        ]

        for phrase in phrases {
            let prepared = RuntimeRequestPreparer.prepare(userText: phrase, context: context)
            XCTAssertEqual(prepared.executionMode, .boundedToolLoop, phrase)
            XCTAssertEqual(prepared.requiredCapabilities, [.currentDateTime], phrase)
            XCTAssertEqual(prepared.resolutionSource, .contextualFollowUp, phrase)
            XCTAssertTrue(prepared.requiresFreshExecution, phrase)
        }
    }

    func testContextualTimeFollowUpsStayConservativeWithoutPriorCapability() {
        let context = ConversationIntentContext(
            conversationID: UUID(),
            recentUserGoal: "这个视频有多长？",
            previousOutcomeStatus: .succeeded,
            previousCompletedAt: Date(),
            recentAssistantCategory: "assistant:completed"
        )

        XCTAssertEqual(RuntimeRequestPreparer.prepare(userText: "具体到秒",
                                                      context: context).executionMode,
                       .conversation)
        XCTAssertEqual(RuntimeRequestPreparer.prepare(userText: "具体到秒").executionMode,
                       .conversation)
    }

    func testContextualTimeFollowUpsAvoidTopicSwitchFalsePositives() {
        let context = ConversationIntentContext(
            conversationID: UUID(),
            recentUserGoal: "现在几点？",
            previousInferredCapabilities: [.currentDateTime],
            previousSuccessfulToolIDs: ["get_current_datetime"],
            previousOutcomeStatus: .succeeded,
            previousCompletedAt: Date(),
            recentAssistantCategory: "activity:succeeded"
        )
        let phrases = [
            "这个视频时长具体到秒",
            "倒计时具体到秒",
            "把邮件里的日期格式具体到秒",
            "format the email date down to the second"
        ]

        for phrase in phrases {
            let prepared = RuntimeRequestPreparer.prepare(userText: phrase, context: context)
            XCTAssertEqual(prepared.executionMode, .conversation, phrase)
            XCTAssertEqual(prepared.resolutionSource, .noMatch, phrase)
        }
    }

    func testContextualTimeFollowUpAfterFailedDateTimeAttemptRequiresFreshRetry() {
        let context = ConversationIntentContext(
            conversationID: UUID(),
            recentUserGoal: "现在几点？",
            previousInferredCapabilities: [.currentDateTime],
            previousSuccessfulToolIDs: [],
            previousOutcomeStatus: .failed,
            previousCompletedAt: Date(),
            recentAssistantCategory: "activity:failed"
        )

        let prepared = RuntimeRequestPreparer.prepare(userText: "具体到秒", context: context)

        XCTAssertEqual(prepared.executionMode, .boundedToolLoop)
        XCTAssertEqual(prepared.requiredCapabilities, [.currentDateTime])
        XCTAssertEqual(prepared.resolutionSource, .contextualFollowUp)
        XCTAssertEqual(prepared.reasonCategory, .previousFailedCurrentDateTimeRetry)
        XCTAssertTrue(prepared.requiresFreshExecution)
    }
}

final class P5SeamTests: XCTestCase {

    func testCategoryMapsToSixLayerMemory() {
        XCTAssertEqual(MemoryLayerMap.layer(for: .preference), .preference)
        XCTAssertEqual(MemoryLayerMap.layer(for: .learningGoal), .episodic)
        XCTAssertEqual(MemoryLayerMap.layer(for: .project), .project)
        XCTAssertEqual(MemoryLayerMap.layer(for: .usageHabit), .procedural)
        XCTAssertEqual(MemoryLayerMap.layer(for: .temporaryContext), .working)
        XCTAssertEqual(MemoryLayer.allCases.count, 6)
    }

    func testMultimodalSlotsDegradeWhenUnavailable() async {
        let v = UnavailableVision(), s = UnavailableSTT(), t = UnavailableTTS()
        XCTAssertFalse(v.isAvailable); XCTAssertFalse(s.isAvailable); XCTAssertFalse(t.isAvailable)
        let vr = await v.describe(imageRef: "x")
        let sr = await s.transcribe(audioRef: "x")
        let tr = await t.synthesize(text: "x")
        XCTAssertNil(vr); XCTAssertNil(sr); XCTAssertNil(tr)
    }
}
