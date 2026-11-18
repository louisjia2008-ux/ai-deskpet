import SwiftUI
import AICore
import PetAgentRuntime

struct AgentResultView: View {
    let document: AgentResultDocument
    var onAction: (AgentResultAction) -> Void = { _ in }
    var onInteraction: (AgentResultInteractionEvent) -> Void = { _ in }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                Text(document.title)
                    .font(DSFont.cardTitle)
                    .foregroundStyle(DSColor.textPrimary)
                    .textSelection(.enabled)
                Spacer()
                StatusPill(text: statusText(document.status),
                           symbol: statusSymbol(document.status),
                           tint: statusTint(document.status))
            }
            Text(document.summary)
                .font(DSFont.secondaryBody)
                .foregroundStyle(DSColor.textSecondary)
                .textSelection(.enabled)
            if let freshness = document.freshness {
                Text(freshness)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .textSelection(.enabled)
            }
            ForEach(document.sections) { section in
                ResultSectionView(document: document,
                                  section: section,
                                  sources: document.sources,
                                  actions: document.actions,
                                  onAction: onAction,
                                  onInteraction: onInteraction)
            }
        }
        .accessibilityElement(children: .contain)
    }

    private func statusText(_ status: AgentResultStatus) -> String {
        switch status {
        case .loading: return "加载中"
        case .partial: return "部分完成"
        case .completed: return "已完成"
        case .failed: return "失败"
        }
    }

    private func statusSymbol(_ status: AgentResultStatus) -> String {
        switch status {
        case .loading: return "progress.indicator"
        case .partial: return "circle.lefthalf.filled"
        case .completed: return "checkmark.circle"
        case .failed: return "exclamationmark.triangle"
        }
    }

    private func statusTint(_ status: AgentResultStatus) -> Color {
        switch status {
        case .loading, .partial: return DSColor.secondaryAccent
        case .completed: return DSColor.primaryAccent
        case .failed: return DSColor.warning
        }
    }
}

private struct ResultSectionView: View {
    let document: AgentResultDocument
    let section: AgentResultSection
    let sources: [AgentResultSource]
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void
    var onInteraction: (AgentResultInteractionEvent) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            if let title = section.title {
                SectionHeader(title)
            }
            if let state = section.state, state.kind == .collapsed, let summary = state.summary {
                InlineNotice(kind: .info, text: summary)
            } else {
                ResultComponentRenderer(document: document,
                                    section: section,
                                    component: section.component,
                                    sources: sources,
                                    actions: actions,
                                    onAction: onAction,
                                    onInteraction: onInteraction)
            }
        }
        .padding(.vertical, DSSpacing.xs)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("result.section.\(section.id)")
    }
}

private struct ResultComponentRenderer: View {
    let document: AgentResultDocument
    let section: AgentResultSection
    let component: AgentResultComponent
    let sources: [AgentResultSource]
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void
    var onInteraction: (AgentResultInteractionEvent) -> Void

    var body: some View {
        switch component {
        case .text(let payload):
            TextResultView(payload: payload)
        case .status(let payload):
            StatusResultView(payload: payload)
        case .progress(let payload):
            ProgressResultView(payload: payload)
        case .keyValue(let payload):
            KeyValueResultView(payload: payload)
        case .list(let payload):
            ListResultView(payload: payload)
        case .choiceList(let payload):
            ChoiceListResultView(document: document,
                                 section: section,
                                 payload: payload,
                                 onInteraction: onInteraction)
        case .table(let payload):
            TableResultView(payload: payload)
        case .comparisonList(let payload):
            ComparisonCardsResultView(payload: .init(cards: payload.items))
        case .cardGrid(let payload):
            ComparisonCardsResultView(payload: .init(cards: payload.cards))
        case .comparisonCards(let payload):
            ComparisonCardsResultView(payload: payload)
        case .timeline(let payload):
            TimelineResultView(payload: payload)
        case .form(let payload):
            FormResultView(payload: payload, actions: actions, onAction: onAction)
        case .confirmation(let payload):
            ConfirmationResultView(payload: payload, actions: actions, onAction: onAction)
        case .map(let payload):
            MapResultView(payload: payload)
        case .chart(let payload):
            ChartResultView(payload: payload)
        case .artifact(let payload):
            ArtifactResultView(payload: payload)
        case .sourceList(let payload):
            SourceListResultView(payload: payload, sources: sources)
        case .actionRow(let payload):
            ResultActionRow(payload: payload, actions: actions, onAction: onAction)
        case .errorRecovery(let payload):
            ErrorRecoveryResultView(payload: payload, actions: actions, onAction: onAction)
        case .emptyState(let payload):
            EmptyStateResultView(payload: payload, actions: actions, onAction: onAction)
        }
    }
}

private struct TextResultView: View {
    let payload: TextComponent
    var body: some View {
        Text(payload.text)
            .font(DSFont.body)
            .foregroundStyle(DSColor.textPrimary)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct StatusResultView: View {
    let payload: StatusComponent
    var body: some View {
        InlineNotice(kind: payload.status == .failed ? .warning : .info,
                     text: [payload.label, payload.detail].compactMap { $0 }.joined(separator: " · "))
    }
}

private struct ProgressResultView: View {
    let payload: ProgressComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack {
                Text(payload.label)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                Spacer()
                Text("\(Int(payload.fraction * 100))%")
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
            }
            ProgressView(value: payload.fraction)
                .progressViewStyle(.linear)
            if let detail = payload.detail {
                Text(detail)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
            }
        }
    }
}

private struct KeyValueResultView: View {
    let payload: KeyValueComponent
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), alignment: .leading)], alignment: .leading, spacing: DSSpacing.s) {
            ForEach(payload.rows) { row in
                VStack(alignment: .leading, spacing: 2) {
                    Text(row.key)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textTertiary)
                    Text(row.value)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textPrimary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

private struct ListResultView: View {
    let payload: ListComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            ForEach(Array(payload.items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: DSSpacing.s) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 5))
                        .foregroundStyle(DSColor.textTertiary)
                        .padding(.top, 7)
                    Text(item)
                        .font(DSFont.body)
                        .foregroundStyle(DSColor.textPrimary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

private struct ChoiceListResultView: View {
    let document: AgentResultDocument
    let section: AgentResultSection
    let payload: ChoiceListComponent
    var onInteraction: (AgentResultInteractionEvent) -> Void

    var body: some View {
        if let summary = payload.resolvedSummary ?? section.state?.summary,
           payload.selectedChoiceID != nil || section.state?.kind == .resolved {
            InlineNotice(kind: .info, text: summary)
        } else {
            VStack(alignment: .leading, spacing: DSSpacing.s) {
                ForEach(payload.choices) { choice in
                    Button {
                        onInteraction(AgentResultInteractionEvent(
                            taskID: document.taskID,
                            runID: document.runID,
                            documentID: document.id,
                            componentID: section.id,
                            actionID: choice.actionID ?? choice.id,
                            payload: .object([
                                "choiceID": .string(choice.id),
                                "title": .string(choice.title)
                            ])))
                    } label: {
                        HStack(alignment: .top, spacing: DSSpacing.s) {
                            Image(systemName: "circle")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(DSColor.secondaryAccent)
                                .frame(width: 16)
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: DSSpacing.xs) {
                                    Text(choice.title)
                                        .font(DSFont.caption)
                                        .foregroundStyle(DSColor.textPrimary)
                                    if let badge = choice.badge {
                                        Text(badge)
                                            .font(DSFont.compactLabel)
                                            .foregroundStyle(DSColor.secondaryAccent)
                                    }
                                }
                                if let subtitle = choice.subtitle {
                                    Text(subtitle)
                                        .font(DSFont.compactLabel)
                                        .foregroundStyle(DSColor.textSecondary)
                                }
                                if let detail = choice.detail {
                                    Text(detail)
                                        .font(DSFont.compactLabel)
                                        .foregroundStyle(DSColor.textTertiary)
                                }
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(DSSpacing.s)
                        .contentShape(Rectangle())
                        .background(DSColor.appBackground.opacity(0.55),
                                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                            .strokeBorder(DSColor.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(choice.title)
                    .accessibilityIdentifier("result.choice.\(choice.id)")
                }
            }
        }
    }
}

private struct TableResultView: View {
    let payload: TableComponent
    var body: some View {
        ScrollView(.horizontal) {
            Grid(alignment: .leading, horizontalSpacing: DSSpacing.m, verticalSpacing: DSSpacing.xs) {
                GridRow {
                    ForEach(payload.columns, id: \.self) { column in
                        Text(column)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textSecondary)
                    }
                }
                Divider().gridCellColumns(max(1, payload.columns.count))
                ForEach(Array(payload.rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, value in
                            Text(value)
                                .font(DSFont.caption)
                                .foregroundStyle(DSColor.textPrimary)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            .padding(DSSpacing.s)
        }
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }
}

private struct ComparisonCardsResultView: View {
    let payload: ComparisonCardsComponent
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: DSSpacing.s)], spacing: DSSpacing.s) {
            ForEach(payload.cards) { card in
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    HStack {
                        Text(card.title)
                            .font(DSFont.cardTitle)
                            .foregroundStyle(DSColor.textPrimary)
                            .lineLimit(2)
                        Spacer()
                    }
                    if let subtitle = card.subtitle {
                        Text(subtitle)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textSecondary)
                            .lineLimit(2)
                    }
                    if let badge = card.badge {
                        Text(badge)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.warning)
                    }
                    KeyValueResultView(payload: .init(rows: card.attributes))
                }
                .padding(DSSpacing.s)
                .background(DSColor.elevatedSurface,
                            in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
                    .strokeBorder(DSColor.border, lineWidth: 1))
            }
        }
    }
}

private struct TimelineResultView: View {
    let payload: TimelineComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            ForEach(payload.items) { item in
                HStack(alignment: .top, spacing: DSSpacing.s) {
                    Image(systemName: "circle")
                        .foregroundStyle(DSColor.secondaryAccent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.title)
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textPrimary)
                        if let detail = item.detail {
                            Text(detail)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                        }
                    }
                    Spacer()
                    if let timestamp = item.timestamp {
                        Text(timestamp, style: .time)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textTertiary)
                    }
                }
            }
        }
    }
}

private struct FormResultView: View {
    let payload: FormComponent
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            ForEach(payload.fields) { field in
                VStack(alignment: .leading, spacing: 2) {
                    Text(field.label + (field.required ? " *" : ""))
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textTertiary)
                    Text(field.value ?? field.placeholder ?? "")
                        .font(DSFont.caption)
                        .foregroundStyle(field.value == nil ? DSColor.textSecondary : DSColor.textPrimary)
                }
            }
            if let submitActionID = payload.submitActionID {
                ResultActionRow(payload: .init(actionIDs: [submitActionID]), actions: actions, onAction: onAction)
            }
        }
    }
}

private struct ConfirmationResultView: View {
    let payload: ConfirmationComponent
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            InlineNotice(kind: payload.resolvedActionID == nil ? .warning : .info, text: payload.message)
            if payload.resolvedActionID == nil {
                ResultActionRow(payload: .init(actionIDs: [payload.confirmActionID, payload.cancelActionID].compactMap { $0 }),
                                actions: actions,
                                onAction: onAction)
            }
        }
    }
}

private struct MapResultView: View {
    let payload: MapComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(spacing: DSSpacing.xs) {
                Image(systemName: "map")
                Text(payload.title ?? "地图数据")
            }
            .font(DSFont.caption)
            .foregroundStyle(DSColor.textPrimary)
            ForEach(payload.points) { point in
                Text("\(point.title) · \(point.coordinate.latitude), \(point.coordinate.longitude)")
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
    }
}

private struct ChartResultView: View {
    let payload: ChartComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            ForEach(payload.series) { series in
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    Text(series.name)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                    ForEach(series.values) { value in
                        HStack(spacing: DSSpacing.s) {
                            Text(value.label)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textTertiary)
                                .frame(width: 72, alignment: .leading)
                            GeometryReader { proxy in
                                RoundedRectangle(cornerRadius: 3)
                                    .fill(DSColor.secondaryAccent.opacity(0.65))
                                    .frame(width: max(2, proxy.size.width * CGFloat(fraction(value.value))))
                            }
                            .frame(height: 8)
                            Text(compactNumber(value.value))
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                        }
                    }
                }
            }
        }
    }

    private func fraction(_ value: Double) -> Double {
        let maxValue = payload.series.flatMap(\.values).map(\.value).filter { $0.isFinite }.max() ?? 1
        guard maxValue > 0, value.isFinite else { return 0 }
        return min(1, max(0, value / maxValue))
    }

    private func compactNumber(_ value: Double) -> String {
        if value.rounded() == value { return "\(Int(value))" }
        return String(format: "%.1f", value)
    }
}

private struct ArtifactResultView: View {
    let payload: ArtifactComponent
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            HStack(spacing: DSSpacing.xs) {
                Image(systemName: "doc")
                Text(payload.title)
            }
            .font(DSFont.caption)
            .foregroundStyle(DSColor.textPrimary)
            Text(payload.kind)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textSecondary)
            if let url = payload.url, let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") {
                Link("打开来源", destination: link)
                    .font(DSFont.compactLabel)
            }
            if let checksum = payload.checksum {
                Text(checksum)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .lineLimit(1)
            }
        }
    }
}

private struct SourceListResultView: View {
    let payload: SourceListComponent
    let sources: [AgentResultSource]
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            ForEach(resolvedSources) { source in
                if let url = source.url, let link = URL(string: url), ["http", "https"].contains(link.scheme?.lowercased() ?? "") {
                    Link(source.title, destination: link)
                        .font(DSFont.caption)
                } else {
                    Text(source.title)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                }
            }
        }
    }

    private var resolvedSources: [AgentResultSource] {
        payload.sourceIDs.compactMap { id in sources.first { $0.id == id } }
    }
}

private struct ResultActionRow: View {
    let payload: ActionRowComponent
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void
    var body: some View {
        HStack(spacing: DSSpacing.s) {
            ForEach(resolvedActions) { action in
                if action.requiresApproval {
                    Button(action.title) { onAction(action) }
                        .buttonStyle(SecondaryButtonStyle())
                } else {
                    Button(action.title) { onAction(action) }
                        .buttonStyle(PrimaryButtonStyle())
                }
            }
        }
    }

    private var resolvedActions: [AgentResultAction] {
        payload.actionIDs.compactMap { id in actions.first { $0.id == id } }
    }
}

private struct ErrorRecoveryResultView: View {
    let payload: ErrorRecoveryComponent
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            InlineNotice(kind: .warning, text: payload.message)
            ResultActionRow(payload: .init(actionIDs: payload.actionIDs),
                            actions: actions,
                            onAction: onAction)
        }
    }
}

private struct EmptyStateResultView: View {
    let payload: EmptyStateComponent
    let actions: [AgentResultAction]
    var onAction: (AgentResultAction) -> Void
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            InlineNotice(kind: .info, text: payload.message)
            ResultActionRow(payload: .init(actionIDs: payload.actionIDs),
                            actions: actions,
                            onAction: onAction)
        }
    }
}
