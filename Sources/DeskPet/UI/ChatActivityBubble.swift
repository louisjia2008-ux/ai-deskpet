import SwiftUI

struct ChatActivityBubble: View {
    let activity: ChatActivityRecord
    var compact: Bool = false
    var localDiscoveryPresentationStore: LocalDiscoveryPresentationStore?
    var placeHandoffViewModel: PlaceHandoffViewModel?

    // P19.1 — while the activity is still active, expand by default so a normal user
    // can read "which tool is running + what it just produced" without entering any
    // developer surface. Once the activity reaches a terminal state, collapse to a
    // compact summary so the timeline stays scannable; the user can still tap to
    // expand history.
    @State private var expanded: Bool = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .bottom, spacing: DSSpacing.s) {
            VStack(alignment: .leading, spacing: DSSpacing.xs) {
                header
                if expanded {
                    details
                }
                if isLocalDiscoveryActivity, let localDiscoveryPresentationStore {
                    LocalDiscoveryResultContainerView(taskID: activity.taskID,
                                                      runID: activity.runID,
                                                      store: localDiscoveryPresentationStore,
                                                      placeHandoffViewModel: placeHandoffViewModel ?? PlaceHandoffViewModel(),
                                                      layout: .compact,
                                                      recoveredFromCheckpoint: activity.status.isTerminal,
                                                      developerMode: false)
                        .padding(.top, DSSpacing.xs)
                        .accessibilityIdentifier("chat.localDiscoveryResult")
                }
            }
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .background(DSColor.elevatedSurface.opacity(backgroundOpacity),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            // P21 — activity bubbles gain a subtle accent glaze + specular
            // edge so they read as glassy tool cards inside the assistant
            // timeline.
            .overlay(LiquidGlassTintOverlay(tint: tint, opacity: 0.05))
            .overlay(LiquidGlassEdgeHighlight(cornerRadius: 8))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(tint.opacity(strokeOpacity), lineWidth: 1))

            Spacer(minLength: compact ? 44 : 52)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.16), value: activity.status)
        .onAppear {
            // P19.1 — apply the active-by-default rule once when the bubble first
            // appears. Subsequent status changes do NOT auto-re-expand: the user's
            // explicit collapse after a tool finishes must be respected.
            expanded = !activity.status.isTerminal
        }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 18, height: 18)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(activity.summary)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                if let detail = activity.detail {
                    Text(detail)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                }
                // P19.1 — when collapsed and we have a single tool, surface its
                // name + result preview so the user can read "what just happened"
                // without expanding. This replaces the previous "tool name hidden
                // until expanded" behaviour with the new active-by-default model
                // (when expanded we render the full multi-tool list below).
                if !expanded, let primaryTool = activity.tools.first,
                   let preview = primaryTool.resultPreview, !preview.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: DSSpacing.xs) {
                        Text(primaryTool.displayName)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textSecondary)
                            .lineLimit(1)
                        Text("·")
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textTertiary)
                            .accessibilityHidden(true)
                        Text(preview)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textSecondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("\(primaryTool.displayName)：\(preview)")
                }
            }

            Spacer(minLength: DSSpacing.s)

            if !activity.tools.isEmpty {
                Button {
                    expanded.toggle()
                } label: {
                    Image(systemName: expanded ? "chevron.up" : "list.bullet")
                        .font(.system(size: 11, weight: .semibold))
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .foregroundStyle(DSColor.textSecondary)
                .help(expanded ? "收起工具详情" : "查看工具详情")
                .accessibilityLabel(expanded ? "收起工具详情" : "查看工具详情")
            }
        }
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(activity.tools) { tool in
                HStack(alignment: .top, spacing: DSSpacing.s) {
                    Image(systemName: tool.icon)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(tint(for: tool.status))
                        .frame(width: 16, height: 16)
                        .accessibilityHidden(true)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(tool.title)
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textPrimary)
                            .lineLimit(1)
                        // P19.1 — show the tool's capability name + (when available)
                        // the real result preview underneath. The preview was sourced
                        // from `AgentToolObservation.userSafeSummary` and re-sanitized
                        // by `ToolOutputPreviewBuilder`, so it carries no secrets.
                        HStack(alignment: .firstTextBaseline, spacing: DSSpacing.xs) {
                            Text(tool.displayName)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                                .lineLimit(1)
                            if let preview = tool.resultPreview, !preview.isEmpty {
                                Text("·")
                                    .font(DSFont.compactLabel)
                                    .foregroundStyle(DSColor.textTertiary)
                                    .accessibilityHidden(true)
                                Text(preview)
                                    .font(DSFont.compactLabel)
                                    .foregroundStyle(DSColor.textSecondary)
                                    .lineLimit(1)
                                    .truncationMode(.tail)
                            }
                        }
                    }

                    Spacer(minLength: DSSpacing.s)

                    Text(statusText(tool.status))
                        .font(DSFont.compactLabel)
                        .foregroundStyle(tint(for: tool.status))
                        .lineLimit(1)
                }
            }
        }
        .padding(.top, 2)
    }

    private var icon: String {
        if let first = activity.tools.first { return first.icon }
        switch activity.status {
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "minus.circle.fill"
        case .waiting: return "lock.shield"
        case .pending, .running: return "waveform.path.ecg"
        }
    }

    private var tint: Color {
        tint(for: activity.status)
    }

    private var horizontalPadding: CGFloat {
        compact || activity.status.isTerminal ? DSSpacing.s : DSSpacing.m
    }

    private var verticalPadding: CGFloat {
        activity.status.isTerminal ? DSSpacing.xs : DSSpacing.s
    }

    private var backgroundOpacity: Double {
        activity.status.isTerminal ? 0.56 : 0.92
    }

    private var strokeOpacity: Double {
        activity.status.isTerminal ? 0.16 : 0.28
    }

    private func tint(for status: ChatActivityStatus) -> Color {
        switch status {
        case .succeeded:
            return DSColor.success
        case .failed:
            // P17 / EX-02 — failed activities use destructive so they don't share the
            // orange "waiting" voice.
            return DSColor.destructive
        case .waiting:
            return DSColor.warning
        case .cancelled:
            return DSColor.textTertiary
        case .pending, .running:
            return DSColor.secondaryAccent
        }
    }

    private func statusText(_ status: ChatActivityStatus) -> String {
        switch status {
        case .pending:
            return "准备中"
        case .running:
            return "执行中"
        case .waiting:
            return "待确认"
        case .succeeded:
            return "已完成"
        case .failed:
            return "未完成"
        case .cancelled:
            return "已停止"
        }
    }

    private var accessibilityLabel: String {
        let tools = activity.tools
            .map { "\($0.title)，\($0.displayName)，\(statusText($0.status))" }
            .joined(separator: "，")
        return [activity.summary, activity.detail, tools.isEmpty ? nil : tools]
            .compactMap { $0 }
            .joined(separator: "，")
    }

    private var isLocalDiscoveryActivity: Bool {
        activity.tools.contains { tool in
            switch tool.toolID {
            case "approximate_location",
                 "local_place_search",
                 "route_distance_estimate",
                 "webpage_read",
                 "structured_place_extraction":
                return true
            default:
                return false
            }
        }
    }
}
