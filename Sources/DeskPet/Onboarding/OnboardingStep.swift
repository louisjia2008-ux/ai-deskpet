import Foundation

// P17-A — onboarding steps. Pure data so the view layer does not own semantics.

enum OnboardingStep: Int, CaseIterable, Identifiable, Equatable {
    case welcome
    case aiSetup
    case permissions
    case safety
    case ready

    var id: Int { rawValue }

    var index: Int { rawValue }

    var totalCount: Int { OnboardingStep.allCases.count }

    var symbol: String {
        switch self {
        case .welcome:    return "hand.wave"
        case .aiSetup:    return "sparkles"
        case .permissions: return "lock.shield"
        case .safety:     return "checklist"
        case .ready:      return "checkmark.seal"
        }
    }

    var title: String {
        switch self {
        case .welcome:     return "欢迎来到 DeskPet"
        case .aiSetup:     return "连接 AI"
        case .permissions: return "隐私与权限"
        case .safety:      return "如何使用工具"
        case .ready:       return "完成设置"
        }
    }

    var subtitle: String {
        switch self {
        case .welcome:     return "桌宠是你的 macOS 桌面伙伴，可以陪你聊天、帮你处理任务。"
        case .aiSetup:     return "选择一个 AI 服务即可开始。你也可以稍后再设置。"
        case .permissions: return "默认按需申请；你随时可以在系统设置里调整。"
        case .safety:      return "涉及系统或网络的操作都会先告知你并需要你确认。"
        case .ready:       return "可以打开桌宠，开始第一次对话了。"
        }
    }
}

/// User choices during the onboarding flow that the coordinator remembers.
enum OnboardingChoice: Equatable {
    case configureProviderLater
    case configureProviderNow
    case openProviderEditor
    case openSystemSettings
    case finish
}
