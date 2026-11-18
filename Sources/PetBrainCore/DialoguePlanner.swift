import Foundation

/// Routes intent into character / desktopAssistant / agent (doc §7). Rule-based in P1 (Rules
/// before Models, §3.3). The planner only PLANS — it never executes tools or starts an agent.
public struct DialoguePlanner: Sendable {

    public init() {}

    private static let assistantKeywords = [
        "提醒", "计时", "倒计时", "番茄", "日历", "日程", "打开", "启动", "总结", "摘要", "新建任务",
    ]
    private static let agentKeywords = [
        "审计", "重构", "修复", "调试整个", "批量", "研究", "跨应用", "编译", "测试并修", "项目分析", "自动化",
    ]
    private static let emotionalKeywords = ["累了", "难过", "压力", "焦虑", "撑不住", "好烦", "陪我"]

    public func plan(for event: InputEvent) -> DialoguePlan {
        switch event.kind {
        case .petClicked:
            return DialoguePlan(route: .character, intent: .clickInteraction, confidence: 1,
                                speakingMode: .casual, animationIntent: .encourage, requiresMemory: false)
        case .userMessage(let text):
            return planText(text)
        }
    }

    private func planText(_ text: String) -> DialoguePlan {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)

        if Self.agentKeywords.contains(where: t.contains) {
            return DialoguePlan(route: .agent, intent: .agentTask, confidence: 0.7,
                                speakingMode: .agentWorking, animationIntent: .prepareToWork, requiresMemory: false)
        }
        if Self.assistantKeywords.contains(where: t.contains) {
            return DialoguePlan(route: .desktopAssistant, intent: .assistantAction, confidence: 0.7,
                                speakingMode: .focusedAssistant, animationIntent: .think, requiresMemory: false)
        }
        if Self.emotionalKeywords.contains(where: t.contains) {
            return DialoguePlan(route: .character, intent: .emotionalSupport, confidence: 0.8,
                                speakingMode: .emotionalSupport, animationIntent: .concerned, requiresMemory: true)
        }
        if t.contains("？") || t.contains("?") || t.contains("怎么") || t.contains("为什么") || t.contains("是什么") {
            return DialoguePlan(route: .character, intent: .knowledge, confidence: 0.7,
                                speakingMode: .tutor, animationIntent: .explain, requiresMemory: true)
        }
        return DialoguePlan(route: .character, intent: .smalltalk, confidence: 0.6,
                            speakingMode: .casual, animationIntent: .listen, requiresMemory: true)
    }
}
