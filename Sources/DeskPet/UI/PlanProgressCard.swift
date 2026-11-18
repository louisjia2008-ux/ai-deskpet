import SwiftUI
import PetAgentRuntime

struct PlanProgressCard: View {
    let plan: PlanPresentationSnapshot
    var onApprove: () -> Void
    var onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .top, spacing: DSSpacing.s) {
                Image(systemName: planIcon)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(plan.containsPrivateDataRead ? DSColor.warning : DSColor.secondaryAccent)
                    .frame(width: 18, height: 18)
                    .accessibilityHidden(true)

                VStack(alignment: .leading, spacing: 2) {
                    Text(plan.goalSummary)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textPrimary)
                        .lineLimit(2)
                    Text(statusText)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(1)
                }

                Spacer(minLength: DSSpacing.s)
            }

            VStack(alignment: .leading, spacing: 5) {
                ForEach(plan.steps) { step in
                    HStack(alignment: .top, spacing: DSSpacing.s) {
                        stepIcon(step.status)
                            .frame(width: 16, height: 16)
                            .padding(.top, 1)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(step.title)
                                .font(DSFont.caption)
                                .foregroundStyle(DSColor.textPrimary)
                                .lineLimit(1)
                            Text(step.toolDisplayName + (step.involvesPrivateData ? " · 日历只读数据" : ""))
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: DSSpacing.s)
                    }
                    .accessibilityLabel("\(step.title)，\(step.status.accessibilityText)")
                }
            }

            if plan.canApprove {
                HStack(spacing: DSSpacing.xs) {
                    Button {
                        onApprove()
                    } label: {
                        Label("执行计划", systemImage: "checkmark")
                            .font(DSFont.compactLabel)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(DSColor.primaryAccent)
                    .background(DSColor.token(.primaryAccent).opacity(0.10),
                                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                    .accessibilityLabel("执行计划")

                    Button {
                        onCancel()
                    } label: {
                        Label("取消", systemImage: "xmark")
                            .font(DSFont.compactLabel)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(DSColor.destructive)
                    .background(DSColor.destructive.opacity(0.08),
                                in: RoundedRectangle(cornerRadius: DSRadius.control, style: .continuous))
                    .accessibilityLabel("取消计划")
                }
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.elevatedSurface.opacity(0.72),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                .strokeBorder(DSColor.border, lineWidth: 1))
    }

    private var planIcon: String {
        plan.containsPrivateDataRead ? "lock.shield" : "list.bullet.rectangle"
    }

    private var statusText: String {
        if plan.containsPrivateDataRead, plan.status == .awaitingApproval {
            return "涉及日历只读数据，确认后才会执行"
        }
        return plan.status.displayText
    }

    @ViewBuilder
    private func stepIcon(_ status: PlanStepStatus) -> some View {
        switch status {
        case .pending:
            Image(systemName: "circle")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(DSColor.textTertiary)
        case .running:
            ProgressView()
                .controlSize(.small)
        case .succeeded, .partial:
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(DSColor.success)
        case .denied, .failed, .timedOut:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(DSColor.warning)
        case .cancelled, .skippedDependency:
            Image(systemName: "minus.circle.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(DSColor.textTertiary)
        case .unknown:
            Image(systemName: "questionmark.circle")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(DSColor.textTertiary)
        }
    }
}

private extension PlanStatus {
    var displayText: String {
        switch self {
        case .planning: return "正在制定计划"
        case .validating: return "正在检查计划"
        case .awaitingApproval: return "等待确认"
        case .approved: return "已确认"
        case .executing: return "正在执行"
        case .replanning: return "正在调整"
        case .verifying: return "正在验证结果"
        case .synthesizing: return "正在整理结果"
        case .completed: return "已完成"
        case .partiallyCompleted: return "部分完成"
        case .cancelled: return "已取消"
        case .failed: return "失败"
        case .unknown: return "状态未知"
        }
    }
}

private extension PlanStepStatus {
    var accessibilityText: String {
        switch self {
        case .pending: return "等待中"
        case .running: return "正在执行"
        case .succeeded: return "已完成"
        case .partial: return "部分完成"
        case .denied: return "权限被拒绝"
        case .failed: return "失败"
        case .timedOut: return "超时"
        case .cancelled: return "已取消"
        case .skippedDependency: return "因依赖失败跳过"
        case .unknown: return "未知"
        }
    }
}
