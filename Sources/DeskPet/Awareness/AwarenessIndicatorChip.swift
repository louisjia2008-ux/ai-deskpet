import SwiftUI
import AICore

/// P18 §23 — Unobtrusive SwiftUI chip showing the current awareness state.
///
/// Lives next to the chat composer or floating chat header. Hidden when the user
/// has awareness OFF; visible for L1+ as a calm label. Respects P17 DesignTokens
/// (DSColor, DSRadius, DSFont, DSMotion).
public struct AwarenessIndicatorChip: View {

    let state: AwarenessIndicatorState
    var screenAgeSeconds: Int? = nil

    public init(state: AwarenessIndicatorState, screenAgeSeconds: Int? = nil) {
        self.state = state
        self.screenAgeSeconds = screenAgeSeconds
    }

    public var body: some View {
        if let presentation = state.presentation(screenAgeSeconds: screenAgeSeconds) {
            HStack(spacing: DSSpacing.xs) {
                Image(systemName: presentation.symbol)
                    .font(.system(size: 10, weight: .semibold))
                Text(presentation.text)
                    .font(DSFont.compactLabel)
                    .lineLimit(1)
            }
            .padding(.horizontal, DSSpacing.s)
            .padding(.vertical, 3)
            .foregroundStyle(presentation.tint)
            .background(presentation.tint.opacity(0.14), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityLabel(presentation.accessibilityLabel)
        } else {
            EmptyView()
        }
    }
}

/// Compact view of the service's effective state for chip rendering. The chip
/// hides when the effective state is `.off` — there is nothing meaningful to
/// show. The host views therefore anchor the chip conditionally.
public enum AwarenessIndicatorState: Sendable, Equatable {
    case off
    case app(displayName: String)
    case title(windowTitle: String)
    case sensitiveSuppressed
    case screenFresh(textPreview: String)
    case screenIdle

    public static func from(perception: PerceptionPolicy,
                            snapshot: AwarenessSnapshot,
                            screenAgeSeconds: Int? = nil) -> AwarenessIndicatorState {
        if perception.maxLevel == .off { return .off }
        if snapshot.sensitiveContextSuppressed {
            return .sensitiveSuppressed
        }
        switch perception.maxLevel {
        case .off:
            return .off
        case .app:
            if let front = snapshot.frontmostApp {
                return .app(displayName: front.displayName)
            }
            return .app(displayName: "")
        case .title:
            if let title = snapshot.activeWindow?.title, !title.isEmpty {
                return .title(windowTitle: title)
            }
            return .title(windowTitle: "")
        case .screen:
            if let st = snapshot.screenText {
                return .screenFresh(textPreview: st.text)
            }
            return .screenIdle
        }
    }

    fileprivate struct Presentation {
        let text: String
        let symbol: String
        let tint: Color
        let accessibilityLabel: String
    }

    fileprivate func presentation(screenAgeSeconds: Int?) -> Presentation? {
        switch self {
        case .off:
            return nil
        case .app(let name):
            let label = name.isEmpty ? "当前应用感知已开启" : "正在了解 \(name)"
            return Presentation(text: label,
                                symbol: "eye",
                                tint: DSColor.secondaryAccent,
                                accessibilityLabel: "桌面感知：\(label)")
        case .title(let title):
            if title.isEmpty {
                return Presentation(text: "窗口标题感知已开启",
                                    symbol: "macwindow",
                                    tint: DSColor.secondaryAccent,
                                    accessibilityLabel: "桌面感知：等待白名单应用")
            }
            return Presentation(text: "窗口：\(title)",
                                symbol: "macwindow",
                                tint: DSColor.secondaryAccent,
                                accessibilityLabel: "桌面感知：正在观察窗口 \(title)")
        case .sensitiveSuppressed:
            return Presentation(text: "敏感应用已屏蔽",
                                symbol: "shield.lefthalf.filled",
                                tint: DSColor.warning,
                                accessibilityLabel: "桌面感知：当前应用是敏感上下文，细节已屏蔽")
        case .screenFresh(let textPreview):
            let preview = String(textPreview.prefix(20))
            let suffix = textPreview.count > 20 ? "…" : ""
            let age = screenAgeSeconds.map { " · \($0)s 前" } ?? ""
            return Presentation(text: "屏幕已读取\(age) · \(preview)\(suffix)",
                                symbol: "rectangle.dashed",
                                tint: DSColor.secondaryAccent,
                                accessibilityLabel: "桌面感知：屏幕读取\(age)")
        case .screenIdle:
            return Presentation(text: "屏幕理解已就绪",
                                symbol: "rectangle.dashed",
                                tint: DSColor.secondaryAccent,
                                accessibilityLabel: "桌面感知：屏幕理解已就绪")
        }
    }
}

// MARK: - DEBUG helpers

#if DEBUG
extension AwarenessIndicatorState {
    /// Test-only: ensures `presentation` always returns *something* when the state
    /// is non-`.off`. The actual `screenAgeSeconds` parameter is non-nil.
    public func testPresentationForcingVisible(screenAgeSeconds: Int? = 0) -> Bool {
        presentation(screenAgeSeconds: screenAgeSeconds) != nil
    }
}
#endif
