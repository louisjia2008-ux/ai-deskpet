import SwiftUI
import PetAgentRuntime

struct TaskActivityCard: View {
    let task: AgentTaskActivitySnapshot
    var onApprove: () -> Void
    var onCancel: () -> Void
    var onStop: () -> Void
    var onRetry: () -> Void
    var onOpenDetails: () -> Void

    @State private var expanded = false

    private var run: AgentTaskRunActivity? { task.latestRun }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            header
            if expanded || run?.status.isTerminal == false {
                timeline
            }
            actions
        }
        .padding(DSSpacing.s)
        .background(DSColor.elevatedSurface.opacity(0.72),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                .strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel)
    }

    private var header: some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: icon)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(tint)
                .frame(width: 18, height: 18)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                Text(subtitle)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineLimit(2)
            }
            Spacer(minLength: DSSpacing.s)
            if let progressText {
                Text(progressText)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .monospacedDigit()
            }
        }
    }

    private var timeline: some View {
        VStack(alignment: .leading, spacing: 5) {
            ForEach(displayEvents) { event in
                HStack(alignment: .top, spacing: DSSpacing.s) {
                    Image(systemName: icon(for: event.kind))
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(tint(for: event.kind))
                        .frame(width: 16, height: 16)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(event.presentation.title)
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textPrimary)
                            .lineLimit(1)
                        if let detail = event.presentation.detail {
                            Text(detail)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                                .lineLimit(2)
                        }
                    }
                    Spacer(minLength: DSSpacing.s)
                }
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        if run?.status == .waitingForApproval {
            HStack(spacing: DSSpacing.xs) {
                Button(action: onCancel) {
                    Label("拒绝", systemImage: "xmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.destructive)
                .padding(.vertical, 6)
                .background(DSColor.destructive.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))

                Button(action: onApprove) {
                    Label("允许一次", systemImage: "checkmark")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.primaryAccent)
                .padding(.vertical, 6)
                .background(DSColor.token(.primaryAccent).opacity(0.10),
                            in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
            }
        } else if run?.status.isTerminal == true {
            HStack(spacing: DSSpacing.xs) {
                Button {
                    expanded.toggle()
                    if expanded { onOpenDetails() }
                } label: {
                    Label(expanded ? "收起" : "查看详情", systemImage: expanded ? "chevron.up" : "list.bullet")
                }
                .buttonStyle(.plain)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.secondaryAccent)

                if run?.status != .succeeded {
                    Button(action: onRetry) {
                        Label("重试", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.plain)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.primaryAccent)
                }
            }
        } else if run?.canShowStopAction == true {
            Button(action: onStop) {
                Label("停止", systemImage: "stop.fill")
            }
            .buttonStyle(.plain)
            .font(DSFont.compactLabel)
            .foregroundStyle(DSColor.destructive)
        }
    }

    private var displayEvents: [AgentTaskActivityEvent] {
        guard let run else { return [] }
        let events = run.userVisibleEvents
        if expanded { return Array(events.suffix(12)) }
        // P17 / AT-05 — collapsed view shows up to 3 key events so the user gets
        // narrative context (first + last + middle) instead of a single line.
        return Array(events.suffix(3))
    }

    private var title: String {
        guard let run else { return "任务" }
        switch run.status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser:
            return "等待你的确认"
        case .succeeded:
            return "已完成"
        case .partiallySucceeded:
            return "部分完成"
        case .failed:
            return "操作失败"
        case .cancelled:
            return "已停止"
        case .paused:
            return "已暂停"
        case .interrupted:
            return "上次生成被应用重启打断，可以重试。"
        default:
            return run.userVisibleEvents.last?.presentation.title ?? "正在处理"
        }
    }

    private var subtitle: String {
        guard let run else { return "暂无活动" }
        if let terminal = run.userVisibleTerminalSummary, run.status.isTerminal {
            return terminal
        }
        switch run.status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser:
            return run.userVisibleEvents.last?.presentation.detail ?? "需要你的允许才能继续。"
        case .synthesizing:
            return "正在整理结果…"
        case .running:
            return run.userVisibleEvents.last?.presentation.title ?? "正在处理…"
        case .planning:
            return "正在处理…"
        case .created:
            return "已创建"
        case .queued:
            return "正在准备"
        case .paused:
            return "暂停在安全边界"
        case .interrupted:
            return "可以重试。"
        default:
            return run.userVisibleEvents.last?.presentation.detail ?? statusText(run.status)
        }
    }

    private var progressText: String? {
        guard let run, let total = run.totalStepCount, total > 0 else { return nil }
        return "\(run.completedStepCount) / \(total)"
    }

    private var icon: String {
        switch run?.status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser: return "lock.shield"
        case .succeeded: return "checkmark.circle.fill"
        case .partiallySucceeded: return "checkmark.circle.trianglebadge.exclamationmark"
        case .failed: return "exclamationmark.triangle.fill"
        case .cancelled: return "minus.circle.fill"
        case .paused: return "pause.circle.fill"
        case .interrupted: return "bolt.horizontal.circle.fill"
        case .synthesizing: return "text.bubble"
        default: return "waveform.path.ecg"
        }
    }

    private var tint: Color {
        switch run?.status {
        case .waitingForApproval, .waitingForPermission, .waitingForUser, .paused, .interrupted: return DSColor.warning
        case .succeeded: return DSColor.success
        case .partiallySucceeded: return DSColor.warning
        case .failed: return DSColor.destructive
        case .cancelled: return DSColor.textTertiary
        default: return DSColor.secondaryAccent
        }
    }

    private var accessibilityLabel: String {
        "\(title)，\(subtitle)" + (progressText.map { "，进度 \($0)" } ?? "")
    }

    private func statusText(_ status: AgentTaskStatus) -> String {
        switch status {
        case .created: return "已创建"
        case .queued: return "等待中"
        case .planning: return "正在规划"
        case .waitingForApproval, .waitingForPermission: return "等待你的确认"
        case .waitingForUser: return "等待用户操作"
        case .running: return "正在处理"
        case .paused: return "已暂停"
        case .synthesizing: return "正在整理"
        case .partiallySucceeded: return "部分完成"
        case .succeeded: return "已完成"
        case .failed: return "操作失败"
        case .cancelled: return "已停止"
        case .interrupted: return "已中断"
        case .unknown: return "状态未知"
        }
    }

    private func icon(for kind: AgentTaskEventKind) -> String {
        switch kind {
        case .stepSucceeded, .taskSucceeded, .synthesisSucceeded, .approvalGranted, .userInteractionResolved, .resultProduced:
            return "checkmark.circle.fill"
        case .stepFailed, .taskFailed, .replanFailed, .approvalDenied:
            return "exclamationmark.triangle.fill"
        case .taskCancelled:
            return "minus.circle.fill"
        case .approvalRequested, .userInteractionRequested:
            return "lock.shield"
        case .stepStarted, .executionStarted:
            return "circle.dotted"
        default:
            return "circle"
        }
    }

    private func tint(for kind: AgentTaskEventKind) -> Color {
        switch kind {
        case .stepSucceeded, .taskSucceeded, .synthesisSucceeded, .approvalGranted, .userInteractionResolved, .resultProduced:
            return DSColor.success
        case .stepFailed, .taskFailed, .replanFailed, .approvalDenied:
            return DSColor.warning
        case .taskCancelled:
            return DSColor.textTertiary
        case .approvalRequested, .userInteractionRequested:
            return DSColor.warning
        default:
            return DSColor.secondaryAccent
        }
    }
}
