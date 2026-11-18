import AppKit
import MapKit
import PetAgentRuntime
import SwiftUI

struct LocalDiscoveryResultContainerView: View {
    enum LayoutMode {
        case compact
        case wide
    }

    let taskID: UUID
    let runID: UUID
    let store: LocalDiscoveryPresentationStore
    @ObservedObject var placeHandoffViewModel: PlaceHandoffViewModel
    var layout: LayoutMode
    var recoveredFromCheckpoint: Bool
    var developerMode: Bool

    @State private var sortMode: LocalDiscoverySortMode
    @State private var selectedCandidateID: LocalDiscoveryCandidateID?

    private var initialEvidenceExpanded: Bool

    init(taskID: UUID,
         runID: UUID,
         store: LocalDiscoveryPresentationStore,
         placeHandoffViewModel: PlaceHandoffViewModel,
         layout: LayoutMode,
         recoveredFromCheckpoint: Bool,
         developerMode: Bool,
         initialSortMode: LocalDiscoverySortMode = .recommended,
         initialSelectedCandidateID: LocalDiscoveryCandidateID? = nil,
         initialEvidenceExpanded: Bool = false) {
        self.taskID = taskID
        self.runID = runID
        self.store = store
        self.placeHandoffViewModel = placeHandoffViewModel
        self.layout = layout
        self.recoveredFromCheckpoint = recoveredFromCheckpoint
        self.developerMode = developerMode
        self.initialEvidenceExpanded = initialEvidenceExpanded
        self._sortMode = State(initialValue: initialSortMode)
        self._selectedCandidateID = State(initialValue: initialSelectedCandidateID)
    }

    var body: some View {
        Group {
            if let presentation = store.presentation(taskID: taskID,
                                                     runID: runID,
                                                     sortMode: sortMode,
                                                     selectedCandidateID: selectedCandidateID,
                                                     recoveredFromCheckpoint: recoveredFromCheckpoint,
                                                     includeDeveloperDiagnostics: developerMode) {
                LocalDiscoveryResultView(presentation: presentation,
                                         placeHandoffViewModel: placeHandoffViewModel,
                                         layout: layout,
                                         developerMode: developerMode,
                                         initialEvidenceExpanded: initialEvidenceExpanded,
                                         sortMode: $sortMode,
                                         selectedCandidateID: $selectedCandidateID)
            } else {
                LocalDiscoverySourceStateView(state: store.state(taskID: taskID, runID: runID))
            }
        }
        .task(id: "\(taskID.uuidString):\(runID.uuidString)") {
            await store.load(taskID: taskID, runID: runID)
        }
    }
}

private struct LocalDiscoverySourceStateView: View {
    let state: LocalDiscoveryPresentationStore.SourceState

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            switch state {
            case .idle, .loading:
                HStack(spacing: DSSpacing.s) {
                    ProgressView()
                        .controlSize(.small)
                    Text("正在恢复地点结果")
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textPrimary)
                }
                .accessibilityLabel("正在恢复地点结果")
            case .missing:
                InlineNotice(kind: .warning, text: "没有找到可恢复的地点结果。")
            case .failed:
                InlineNotice(kind: .warning, text: "地点结果恢复失败。")
            case .loaded:
                EmptyView()
            }
        }
        .accessibilityIdentifier("localDiscovery.sourceState")
    }
}

struct LocalDiscoveryResultView: View {
    let presentation: LocalDiscoveryPresentation
    @ObservedObject var placeHandoffViewModel: PlaceHandoffViewModel
    var layout: LocalDiscoveryResultContainerView.LayoutMode
    var developerMode: Bool

    @Binding var sortMode: LocalDiscoverySortMode
    @Binding var selectedCandidateID: LocalDiscoveryCandidateID?

    @State private var showMap: Bool
    @State private var evidenceExpanded = false
    @State private var expandedCandidateIDs: Set<LocalDiscoveryCandidateID> = []
    @State private var cameraPosition: MapCameraPosition = .automatic
    @State private var didSetInitialCamera = false
    @State private var mapWasMovedByUser = false

    init(presentation: LocalDiscoveryPresentation,
         placeHandoffViewModel: PlaceHandoffViewModel,
         layout: LocalDiscoveryResultContainerView.LayoutMode,
         developerMode: Bool,
         initialEvidenceExpanded: Bool = false,
         sortMode: Binding<LocalDiscoverySortMode>,
         selectedCandidateID: Binding<LocalDiscoveryCandidateID?>) {
        self.presentation = presentation
        self.placeHandoffViewModel = placeHandoffViewModel
        self.layout = layout
        self.developerMode = developerMode
        self._sortMode = sortMode
        self._selectedCandidateID = selectedCandidateID
        self._showMap = State(initialValue: layout == .wide)
        self._evidenceExpanded = State(initialValue: initialEvidenceExpanded)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            LocalDiscoveryQuerySummaryView(presentation: presentation)
            LocalDiscoveryToolbar(presentation: presentation,
                                  layout: layout,
                                  sortMode: $sortMode,
                                  showMap: $showMap)

            terminalState

            if !presentation.candidates.isEmpty {
                resultsLayout
            }

            LocalDiscoveryEvidenceSummaryView(evidence: presentation.evidenceSummary,
                                              expanded: $evidenceExpanded,
                                              developerMode: developerMode)

            if developerMode, let diagnostics = presentation.developerDiagnostics {
                LocalDiscoveryDeveloperDiagnosticsView(diagnostics: diagnostics)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("localDiscovery.result")
        .onAppear(perform: fitInitialCameraIfNeeded)
        .onChange(of: presentation.mapAnnotations) {
            fitInitialCameraIfNeeded()
        }
        .onChange(of: selectedCandidateID) {
            focusSelectedCandidate()
        }
        .sheet(item: $placeHandoffViewModel.activePreview,
               onDismiss: { placeHandoffViewModel.dismissActivePreview() }) { preview in
            PlaceHandoffPreviewSheet(preview: preview,
                                     record: placeHandoffViewModel.record(for: preview.request.requestID),
                                     developerMode: developerMode,
                                     onCancel: {
                                         placeHandoffViewModel.cancel(preview.request.requestID)
                                     },
                                     onConfirm: {
                                         Task { await placeHandoffViewModel.confirm(preview.request.requestID) }
                                     },
                                     onRetry: {
                                         Task { await placeHandoffViewModel.retry(preview.request.requestID) }
                                     })
                .frame(minWidth: 420, idealWidth: 480)
                .presentationDetents([.medium])
        }
    }

    @ViewBuilder
    private var terminalState: some View {
        switch presentation.status {
        case .cancelled:
            LocalDiscoveryTerminalStateView(symbol: "minus.circle.fill",
                                            title: "搜索已停止",
                                            message: "没有残留的生成状态。未完成候选不会显示为已验证推荐。",
                                            tint: DSColor.textTertiary)
                .accessibilityIdentifier("localDiscovery.cancelled")
        case .failed(let error):
            LocalDiscoveryTerminalStateView(symbol: "exclamationmark.triangle.fill",
                                            title: "地点搜索未完成",
                                            message: error.userMessage,
                                            tint: DSColor.warning)
                .accessibilityIdentifier("localDiscovery.failed")
        case .empty(let reason):
            LocalDiscoveryEmptyStateView(reason: reason)
                .accessibilityIdentifier("localDiscovery.empty")
        default:
            EmptyView()
        }
    }

    @ViewBuilder
    private var resultsLayout: some View {
        if layout == .compact {
            VStack(alignment: .leading, spacing: DSSpacing.m) {
	                LocalDiscoveryCandidateList(candidates: presentation.candidates,
	                                            placeHandoffViewModel: placeHandoffViewModel,
	                                            selectedCandidateID: $selectedCandidateID,
                                            expandedCandidateIDs: $expandedCandidateIDs,
                                            developerMode: developerMode)
                if showMap {
                    mapPanel
                        .frame(height: 240)
                }
            }
        } else {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .top, spacing: DSSpacing.m) {
	                    LocalDiscoveryCandidateList(candidates: presentation.candidates,
	                                                placeHandoffViewModel: placeHandoffViewModel,
	                                                selectedCandidateID: $selectedCandidateID,
                                                expandedCandidateIDs: $expandedCandidateIDs,
                                                developerMode: developerMode)
                        .frame(minWidth: 320, idealWidth: 420, maxWidth: 520)
                    mapPanel
                        .frame(minWidth: 320, minHeight: 360)
                }
                VStack(alignment: .leading, spacing: DSSpacing.m) {
	                    LocalDiscoveryCandidateList(candidates: presentation.candidates,
	                                                placeHandoffViewModel: placeHandoffViewModel,
	                                                selectedCandidateID: $selectedCandidateID,
                                                expandedCandidateIDs: $expandedCandidateIDs,
                                                developerMode: developerMode)
                    mapPanel
                        .frame(height: 320)
                }
            }
        }
    }

    @ViewBuilder
    private var mapPanel: some View {
        if presentation.mapAnnotations.isEmpty {
            LocalDiscoveryMapEmptyView()
        } else {
            LocalDiscoveryMapView(annotations: presentation.mapAnnotations,
                                  selectedCandidateID: $selectedCandidateID,
                                  cameraPosition: $cameraPosition,
                                  mapWasMovedByUser: $mapWasMovedByUser)
        }
    }

    private func fitInitialCameraIfNeeded() {
        guard !didSetInitialCamera, !presentation.mapAnnotations.isEmpty else { return }
        didSetInitialCamera = true
        cameraPosition = .region(region(for: presentation.mapAnnotations))
    }

    private func focusSelectedCandidate() {
        guard let selectedCandidateID,
              let annotation = presentation.mapAnnotations.first(where: { $0.id == selectedCandidateID }) else {
            return
        }
        cameraPosition = .region(MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: annotation.coordinate.latitude,
                                                                                  longitude: annotation.coordinate.longitude),
                                                    latitudinalMeters: 1_600,
                                                    longitudinalMeters: 1_600))
    }

    private func region(for annotations: [LocalDiscoveryMapAnnotationPresentation]) -> MKCoordinateRegion {
        guard annotations.count > 1 else {
            let point = annotations[0].coordinate
            return MKCoordinateRegion(center: CLLocationCoordinate2D(latitude: point.latitude,
                                                                     longitude: point.longitude),
                                      latitudinalMeters: 2_000,
                                      longitudinalMeters: 2_000)
        }
        let latitudes = annotations.map(\.coordinate.latitude)
        let longitudes = annotations.map(\.coordinate.longitude)
        let minLat = latitudes.min() ?? 0
        let maxLat = latitudes.max() ?? 0
        let minLon = longitudes.min() ?? 0
        let maxLon = longitudes.max() ?? 0
        let center = CLLocationCoordinate2D(latitude: (minLat + maxLat) / 2,
                                            longitude: (minLon + maxLon) / 2)
        let latMeters = max(2_000, (maxLat - minLat) * 111_000 * 1.35)
        let lonMeters = max(2_000, (maxLon - minLon) * 88_000 * 1.35)
        return MKCoordinateRegion(center: center,
                                  latitudinalMeters: min(latMeters, 160_000),
                                  longitudinalMeters: min(lonMeters, 160_000))
    }
}

private struct LocalDiscoveryQuerySummaryView: View {
    let presentation: LocalDiscoveryPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack(alignment: .top, spacing: DSSpacing.s) {
                Image(systemName: statusSymbol)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(statusTint)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(presentation.querySummary.intentSummary)
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(presentation.querySummary.statusSummary)
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: DSSpacing.s)
                StatusPill(text: presentation.status.userLabel,
                           symbol: statusSymbol,
                           tint: statusTint)
            }

            LazyVGrid(columns: [GridItem(.adaptive(minimum: 128), alignment: .leading)],
                      alignment: .leading,
                      spacing: DSSpacing.xs) {
                summaryMetric("位置", presentation.querySummary.locationLabel)
                summaryMetric("类别", presentation.querySummary.categoryLabel)
                summaryMetric("结果", presentation.querySummary.resultCountSummary)
                if presentation.recoveredFromCheckpoint {
                    summaryMetric("恢复", "来自 checkpoint")
                }
            }

            if !presentation.querySummary.constraintSummaries.isEmpty {
                Text(presentation.querySummary.constraintSummaries.joined(separator: " · "))
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous)
            .strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(presentation.querySummary.intentSummary)，\(presentation.querySummary.statusSummary)")
        .accessibilityIdentifier("localDiscovery.summary")
    }

    private func summaryMetric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textTertiary)
            Text(value)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
                .lineLimit(2)
        }
    }

    private var statusSymbol: String {
        switch presentation.status {
        case .complete: return "checkmark.circle.fill"
        case .partial: return "circle.lefthalf.filled"
        case .empty: return "magnifyingglass"
        case .cancelled: return "minus.circle.fill"
        case .failed: return "exclamationmark.triangle.fill"
        case .preparing, .searching, .routing, .readingEvidence, .verifying, .synthesizing:
            return "waveform.path.ecg"
        }
    }

    private var statusTint: Color {
        switch presentation.status {
        case .complete: return DSColor.success
        case .partial, .empty: return DSColor.warning
        case .cancelled: return DSColor.textTertiary
        case .failed: return DSColor.warning
        case .preparing, .searching, .routing, .readingEvidence, .verifying, .synthesizing:
            return DSColor.secondaryAccent
        }
    }
}

private struct LocalDiscoveryToolbar: View {
    let presentation: LocalDiscoveryPresentation
    var layout: LocalDiscoveryResultContainerView.LayoutMode
    @Binding var sortMode: LocalDiscoverySortMode
    @Binding var showMap: Bool

    var body: some View {
        HStack(spacing: DSSpacing.s) {
            Picker("排序", selection: $sortMode) {
                ForEach(LocalDiscoverySortMode.allCases, id: \.self) { mode in
                    Text(mode.userLabel).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .disabled(presentation.candidates.count < 2)
            .accessibilityIdentifier("localDiscovery.sort")

            Spacer(minLength: DSSpacing.s)

            if layout == .compact {
                Button {
                    showMap.toggle()
                } label: {
                    Label(showMap ? "收起地图" : "地图", systemImage: showMap ? "map.fill" : "map")
                }
                .buttonStyle(.plain)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.secondaryAccent)
                .accessibilityIdentifier("localDiscovery.mapToggle")
            }
        }
    }
}

private struct LocalDiscoveryCandidateList: View {
    let candidates: [LocalDiscoveryCandidatePresentation]
    @ObservedObject var placeHandoffViewModel: PlaceHandoffViewModel
    @Binding var selectedCandidateID: LocalDiscoveryCandidateID?
    @Binding var expandedCandidateIDs: Set<LocalDiscoveryCandidateID>
    var developerMode: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: DSSpacing.s) {
                    ForEach(candidates) { candidate in
	                        LocalDiscoveryCandidateCard(candidate: candidate,
	                                                    placeHandoffViewModel: placeHandoffViewModel,
	                                                    isExpanded: expandedCandidateIDs.contains(candidate.id),
                                                    developerMode: developerMode,
                                                    onSelect: { selectedCandidateID = candidate.id },
                                                    onToggleExpanded: {
                                                        if expandedCandidateIDs.contains(candidate.id) {
                                                            expandedCandidateIDs.remove(candidate.id)
                                                        } else {
                                                            expandedCandidateIDs.insert(candidate.id)
                                                        }
                                                    })
                        .id(candidate.id)
                    }
                }
            }
            .frame(minHeight: 180, maxHeight: developerMode ? 620 : 520)
            .onChange(of: selectedCandidateID) {
                if let selectedCandidateID {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        proxy.scrollTo(selectedCandidateID, anchor: .center)
                    }
                }
            }
        }
        .accessibilityIdentifier("localDiscovery.candidateList")
    }
}

private struct LocalDiscoveryCandidateCard: View {
    let candidate: LocalDiscoveryCandidatePresentation
    @ObservedObject var placeHandoffViewModel: PlaceHandoffViewModel
    var isExpanded: Bool
    var developerMode: Bool
    var onSelect: () -> Void
    var onToggleExpanded: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            cardHeader
            quickFacts
            if let rationale = candidate.rationale {
                Text(rationale)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isExpanded {
                LocalDiscoveryCandidateDetailView(candidate: candidate,
                                                  developerMode: developerMode)
            }
            cardActions
            handoffActions
        }
        .padding(DSSpacing.s)
        .background(candidate.isSelected ? DSColor.token(.primaryAccent).opacity(0.10) : DSColor.elevatedSurface,
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(candidate.isSelected ? DSColor.primaryAccent : DSColor.border,
                          lineWidth: candidate.isSelected ? 1.5 : 1))
        .contentShape(Rectangle())
        .onTapGesture(perform: onSelect)
        .focusable(true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(candidate.accessibilityLabel)
        .accessibilityAddTraits(candidate.isSelected ? [.isSelected, .isButton] : .isButton)
        .accessibilityIdentifier("localDiscovery.candidate.\(candidate.id)")
        .task(id: "external-handlers-\(candidate.id)") {
            await placeHandoffViewModel.refreshExternalHandlerEligibility(candidate: candidate)
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            placeHandoffViewModel.invalidateExternalHandlerEligibility()
            Task {
                await placeHandoffViewModel.refreshExternalHandlerEligibility(candidate: candidate)
            }
        }
    }

    private var cardHeader: some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            VStack(alignment: .leading, spacing: 3) {
                Text("#\(candidate.rank) \(candidate.name)")
                    .font(DSFont.cardTitle)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                    .textSelection(.enabled)
                Text(candidate.addressSummary)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }
            Spacer(minLength: DSSpacing.s)
            StatusPill(text: candidate.verificationLabel,
                       symbol: verificationSymbol,
                       tint: verificationTint)
        }
    }

    private var quickFacts: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 118), alignment: .leading)],
                  alignment: .leading,
                  spacing: DSSpacing.xs) {
            fact("类别", candidate.categoryLabel)
            fact("距离", candidate.distanceSummary)
            fact("路线", candidate.routeDurationSummary)
            fact("营业", candidate.openingSummary)
            fact("价格", candidate.priceSummary)
            fact("停车", candidate.parkingSummary)
        }
    }

    private func fact(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textTertiary)
            Text(value)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
                .lineLimit(2)
        }
    }

    private var cardActions: some View {
        HStack(spacing: DSSpacing.xs) {
            Button {
                onToggleExpanded()
            } label: {
                Image(systemName: isExpanded ? "chevron.up" : "info.circle")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help(isExpanded ? "收起详情" : "展开详情")
            .accessibilityLabel(isExpanded ? "收起地点详情" : "展开地点详情")

            Button {
                copy(candidate.name)
            } label: {
                Image(systemName: "doc.on.doc")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help("复制地点名称")
            .accessibilityLabel("复制地点名称")

            Button {
                copy(candidate.addressSummary)
            } label: {
                Image(systemName: "mappin.and.ellipse")
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .help("复制地址")
            .accessibilityLabel("复制地址")

            Spacer()

            if candidate.hasValidCoordinate {
                Image(systemName: "map")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .accessibilityLabel("有地图标记")
            }
        }
        .font(DSFont.caption)
        .foregroundStyle(DSColor.secondaryAccent)
    }

    private var handoffActions: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            if let warning = firstVisibleHandoffWarning {
                InlineNotice(kind: .warning, text: warning)
                    .accessibilityIdentifier("localDiscovery.handoff.warning.\(candidate.id)")
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 86), spacing: DSSpacing.xs)],
                      alignment: .leading,
                      spacing: DSSpacing.xs) {
                ForEach(candidate.handoffActions) { action in
                    let eligibility = effectiveEligibility(for: action)
                    let blocked = !eligibility.isAvailable
                    let running = placeHandoffViewModel.isDispatching(action: action.action,
                                                                      candidate: candidate)
                    Button {
                        placeHandoffViewModel.prepare(action: action.action, candidate: candidate)
                    } label: {
                        Label(running ? "进行中" : action.compactTitle,
                              systemImage: running ? "hourglass" : action.systemImageName)
                            .font(DSFont.caption)
                            .lineLimit(1)
                            .minimumScaleFactor(0.86)
                            .frame(maxWidth: .infinity, minHeight: 28)
                    }
                    .buttonStyle(.bordered)
                    .disabled(blocked || running)
                    .help(blocked ? unavailableHelp(for: eligibility) : availableHelp(for: eligibility))
                    .accessibilityLabel(action.accessibilityLabel)
                    .accessibilityHint(blocked ? unavailableHelp(for: eligibility) : action.accessibilityHint)
                    .accessibilityIdentifier("localDiscovery.handoff.\(candidate.id).\(action.action.rawValue)")
                }
            }
            if let unavailableReason = firstUnavailableHandoffReason {
                Text(unavailableReason)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.warning)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("localDiscovery.handoff.unavailableReason.\(candidate.id)")
            }
            if let record = latestTerminalRecord {
                HStack(alignment: .center, spacing: DSSpacing.xs) {
                    Image(systemName: terminalSymbol(record.state))
                        .foregroundStyle(terminalTint(record.state))
                        .accessibilityHidden(true)
                    Text(record.terminalMessage ?? record.state.userTitle)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                }
                .accessibilityIdentifier("localDiscovery.handoff.terminal.\(candidate.id)")
            }
        }
    }

    private var firstVisibleHandoffWarning: String? {
        candidate.handoffActions
            .flatMap { effectiveEligibility(for: $0).warnings.map(\.userMessage) }
            .first
    }

    private var firstUnavailableHandoffReason: String? {
        candidate.handoffActions
            .map { effectiveEligibility(for: $0) }
            .filter { !$0.isAvailable }
            .compactMap { $0.blockingReasons.first?.userMessage }
            .first
    }

    private var latestTerminalRecord: PlaceHandoffExecutionRecord? {
        candidate.handoffActions
            .compactMap { placeHandoffViewModel.record(action: $0.action, candidate: candidate) }
            .filter { $0.state.isTerminal }
            .sorted { $0.updatedAt > $1.updatedAt }
            .first
    }

    private func effectiveEligibility(for action: PlaceHandoffActionPresentation) -> PlaceHandoffEligibility {
        placeHandoffViewModel.environmentEligibility(for: action,
                                                     candidate: candidate)
    }

    private func availableHelp(for eligibility: PlaceHandoffEligibility) -> String {
        let warning = eligibility.warnings.first?.userMessage
        return warning ?? "点击后会显示预览并要求确认"
    }

    private func unavailableHelp(for eligibility: PlaceHandoffEligibility) -> String {
        eligibility.blockingReasons.first?.userMessage
            ?? "该地点操作当前不可用"
    }

    private func terminalSymbol(_ state: PlaceHandoffExecutionState) -> String {
        switch state {
        case .handedOff: return "arrow.up.forward.circle.fill"
        case .cancelled: return "minus.circle.fill"
        case .rejected, .failed, .interrupted: return "exclamationmark.triangle.fill"
        case .previewing, .awaitingConfirmation, .dispatching: return "hourglass"
        }
    }

    private func terminalTint(_ state: PlaceHandoffExecutionState) -> Color {
        switch state {
        case .handedOff: return DSColor.success
        case .cancelled: return DSColor.textTertiary
        case .rejected, .failed, .interrupted: return DSColor.warning
        case .previewing, .awaitingConfirmation, .dispatching: return DSColor.secondaryAccent
        }
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    private var verificationSymbol: String {
        switch candidate.verificationState {
        case .confirmed: return "checkmark.circle.fill"
        case .partial: return "circle.lefthalf.filled"
        case .unknown: return "questionmark.circle"
        case .conflicting: return "exclamationmark.triangle.fill"
        case .stale: return "clock.badge.exclamationmark"
        case .notApplicable: return "slash.circle"
        }
    }

    private var verificationTint: Color {
        switch candidate.verificationState {
        case .confirmed: return DSColor.success
        case .partial, .stale: return DSColor.warning
        case .unknown, .notApplicable: return DSColor.textTertiary
        case .conflicting: return DSColor.warning
        }
    }
}

struct PlaceHandoffPreviewSheet: View {
    let preview: PlaceHandoffPreview
    let record: PlaceHandoffExecutionRecord?
    var developerMode: Bool
    var onCancel: () -> Void
    var onConfirm: () -> Void
    var onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.m) {
            HStack(alignment: .top, spacing: DSSpacing.s) {
                Image(systemName: preview.request.action.systemImageName)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(DSColor.secondaryAccent)
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(preview.title)
                        .font(DSFont.cardTitle)
                        .foregroundStyle(DSColor.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text("等待你的确认")
                        .font(DSFont.caption)
                        .foregroundStyle(DSColor.textSecondary)
                }
                Spacer(minLength: DSSpacing.s)
            }

            VStack(alignment: .leading, spacing: DSSpacing.s) {
                ForEach(preview.rows) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.label)
                            .font(DSFont.compactLabel)
                            .foregroundStyle(DSColor.textTertiary)
                        Text(row.value)
                            .font(DSFont.caption)
                            .foregroundStyle(DSColor.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                            .textSelection(.enabled)
                    }
                }
            }

            ForEach(preview.warnings, id: \.self) { warning in
                InlineNotice(kind: .warning, text: warning)
                    .accessibilityIdentifier("placeHandoff.preview.warning")
            }

            if let record {
                terminalState(record)
            }

            if developerMode {
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    SectionHeader("Developer")
                    ForEach(preview.developerDiagnostics) { row in
                        HStack(alignment: .firstTextBaseline, spacing: DSSpacing.s) {
                            Text(row.label)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textTertiary)
                            Text(row.value)
                                .font(DSFont.compactLabel)
                                .foregroundStyle(DSColor.textSecondary)
                                .lineLimit(1)
                                .textSelection(.enabled)
                        }
                    }
                }
                .padding(DSSpacing.s)
                .background(DSColor.appBackground.opacity(0.55),
                            in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .accessibilityIdentifier("placeHandoff.preview.developer")
            }

            HStack(spacing: DSSpacing.s) {
                Button("取消", role: .cancel) {
                    onCancel()
                    dismiss()
                }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("placeHandoff.cancel")

                Spacer()

                if let record, canRetry(record.state) {
                    Button("重试") {
                        onRetry()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(record.state == .dispatching)
                    .accessibilityIdentifier("placeHandoff.retry")
                } else if isConfirmVisible {
                    Button(preview.confirmTitle) {
                        onConfirm()
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(record?.state == .dispatching || record?.state.isTerminal == true)
                    .accessibilityIdentifier("placeHandoff.confirm")
                }
            }
        }
        .padding(DSSpacing.l)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("placeHandoff.preview")
    }

    @ViewBuilder
    private func terminalState(_ record: PlaceHandoffExecutionRecord) -> some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: symbol(for: record.state))
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint(for: record.state))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(record.state.userTitle)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                if let message = record.terminalMessage {
                    Text(message)
                        .font(DSFont.compactLabel)
                        .foregroundStyle(DSColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if developerMode, let audit = record.externalHandlerAudit {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("handler: \(audit.returnedHandlerBundleIdentifier ?? audit.registeredHandlerBundleIdentifier ?? "unknown")")
                        Text("system open: \(audit.systemOpenAccepted == true ? "accepted" : "not accepted")")
                        Text("handler UI: \(audit.handlerUIVisibility.rawValue)")
                    }
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .textSelection(.enabled)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(DSSpacing.s)
        .background(tint(for: record.state).opacity(0.10),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityIdentifier("placeHandoff.terminal.\(record.state.rawValue)")
    }

    private var isConfirmVisible: Bool {
        guard let record else { return true }
        return !record.state.isTerminal
    }

    private func canRetry(_ state: PlaceHandoffExecutionState) -> Bool {
        switch state {
        case .rejected, .cancelled, .failed, .interrupted:
            return true
        case .handedOff, .previewing, .awaitingConfirmation, .dispatching:
            return false
        }
    }

    private func symbol(for state: PlaceHandoffExecutionState) -> String {
        switch state {
        case .handedOff: return "arrow.up.forward.circle.fill"
        case .cancelled: return "minus.circle.fill"
        case .rejected, .failed, .interrupted: return "exclamationmark.triangle.fill"
        case .previewing, .awaitingConfirmation, .dispatching: return "hourglass"
        }
    }

    private func tint(for state: PlaceHandoffExecutionState) -> Color {
        switch state {
        case .handedOff: return DSColor.success
        case .cancelled: return DSColor.textTertiary
        case .rejected, .failed, .interrupted: return DSColor.warning
        case .previewing, .awaitingConfirmation, .dispatching: return DSColor.secondaryAccent
        }
    }
}

private struct LocalDiscoveryCandidateDetailView: View {
    let candidate: LocalDiscoveryCandidatePresentation
    var developerMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Divider().overlay(DSColor.border)
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 160), alignment: .leading)],
                      alignment: .leading,
                      spacing: DSSpacing.s) {
                ForEach(candidate.fields) { field in
                    LocalDiscoveryFieldRow(field: field)
                }
            }
            if !candidate.conflictSummaries.isEmpty {
                InlineNotice(kind: .warning,
                             text: candidate.conflictSummaries.prefix(2).joined(separator: "；"))
            }
            if !candidate.evidence.isEmpty {
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    SectionHeader("证据")
                    ForEach(candidate.evidence.prefix(6)) { item in
                        LocalDiscoveryEvidenceRow(item: item, developerMode: developerMode)
                    }
                }
            }
            if developerMode, let diagnostics = candidate.developerDiagnostics {
                LocalDiscoveryDeveloperDiagnosticsView(diagnostics: diagnostics)
            }
        }
        .accessibilityIdentifier("localDiscovery.candidate.details.\(candidate.id)")
    }
}

private struct LocalDiscoveryFieldRow: View {
    let field: LocalDiscoveryFieldPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: DSSpacing.xs) {
                Image(systemName: symbol)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(tint)
                    .accessibilityHidden(true)
                Text(field.label)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
            }
            Text(field.value)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            Text(field.state.userLabel)
                .font(DSFont.compactLabel)
                .foregroundStyle(tint)
            if let detail = field.detail {
                Text(detail)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(field.label)，\(field.value)，\(field.state.userLabel)")
    }

    private var symbol: String {
        switch field.state {
        case .confirmed: return "checkmark.circle.fill"
        case .partial: return "circle.lefthalf.filled"
        case .unknown: return "questionmark.circle"
        case .conflicting: return "exclamationmark.triangle.fill"
        case .stale: return "clock.badge.exclamationmark"
        case .notApplicable: return "slash.circle"
        }
    }

    private var tint: Color {
        switch field.state {
        case .confirmed: return DSColor.success
        case .partial, .stale, .conflicting: return DSColor.warning
        case .unknown, .notApplicable: return DSColor.textTertiary
        }
    }
}

private struct LocalDiscoveryEvidenceSummaryView: View {
    let evidence: LocalDiscoveryEvidencePresentation
    @Binding var expanded: Bool
    var developerMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            HStack {
                SectionHeader("证据与可信度")
                Spacer()
                Button {
                    expanded.toggle()
                } label: {
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .help(expanded ? "收起证据" : "展开证据")
                .accessibilityLabel(expanded ? "收起证据说明" : "展开证据说明")
            }
            ForEach(Array(evidence.summaryLines.enumerated()), id: \.offset) { _, line in
                Text(line)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if expanded {
                VStack(alignment: .leading, spacing: DSSpacing.xs) {
                    ForEach(evidence.items) { item in
                        LocalDiscoveryEvidenceRow(item: item, developerMode: developerMode)
                    }
                }
                .accessibilityIdentifier("localDiscovery.evidence.expanded")
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityIdentifier("localDiscovery.evidence")
    }
}

private struct LocalDiscoveryEvidenceRow: View {
    let item: LocalDiscoveryEvidenceItemPresentation
    var developerMode: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: DSSpacing.xs) {
                Text(item.sourceTitle)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                    .lineLimit(2)
                Spacer(minLength: DSSpacing.s)
                Text(item.state.userLabel)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(tint)
            }
            Text([item.sourceType, item.confidenceLabel, item.freshness].joined(separator: " · "))
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textSecondary)
                .lineLimit(2)
            if developerMode {
                Text([item.id, item.developerToolID].compactMap { $0 }.joined(separator: " · "))
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textTertiary)
                    .lineLimit(1)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.sourceTitle)，\(item.state.userLabel)，\(item.confidenceLabel)")
    }

    private var tint: Color {
        switch item.state {
        case .confirmed: return DSColor.success
        case .partial, .stale, .conflicting: return DSColor.warning
        case .unknown, .notApplicable: return DSColor.textTertiary
        }
    }
}

private struct LocalDiscoveryMapView: View {
    let annotations: [LocalDiscoveryMapAnnotationPresentation]
    @Binding var selectedCandidateID: LocalDiscoveryCandidateID?
    @Binding var cameraPosition: MapCameraPosition
    @Binding var mapWasMovedByUser: Bool

    var body: some View {
        Map(position: $cameraPosition, selection: $selectedCandidateID) {
            ForEach(annotations) { annotation in
                Marker(annotation.title,
                       systemImage: selectedCandidateID == annotation.id ? "mappin.circle.fill" : "mappin",
                       coordinate: CLLocationCoordinate2D(latitude: annotation.coordinate.latitude,
                                                          longitude: annotation.coordinate.longitude))
                    .tint(tint(for: annotation))
                    .tag(annotation.id)
            }
        }
        .mapStyle(.standard)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(alignment: .topLeading) {
            Text("地图只显示有可靠坐标的候选")
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textSecondary)
                .padding(.horizontal, DSSpacing.s)
                .padding(.vertical, 5)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                .padding(DSSpacing.s)
        }
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(DSColor.border, lineWidth: 1))
        .onMapCameraChange(frequency: .onEnd) { _ in
            mapWasMovedByUser = true
        }
        .accessibilityIdentifier("localDiscovery.map")
    }

    private func tint(for annotation: LocalDiscoveryMapAnnotationPresentation) -> Color {
        if annotation.id == selectedCandidateID { return DSColor.primaryAccent }
        switch annotation.verificationState {
        case .confirmed: return DSColor.success
        case .partial: return DSColor.secondaryAccent
        case .unknown, .stale, .notApplicable: return DSColor.textTertiary
        case .conflicting: return DSColor.warning
        }
    }
}

private struct LocalDiscoveryMapEmptyView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.s) {
            Image(systemName: "map")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(DSColor.textTertiary)
                .accessibilityHidden(true)
            Text("没有可用于地图的坐标")
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
            Text("列表仍可比较；没有坐标、坐标无效或置信度不足的候选不会伪造 marker。")
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .center)
        .padding(DSSpacing.m)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(DSColor.border, lineWidth: 1))
        .accessibilityIdentifier("localDiscovery.map.empty")
    }
}

private struct LocalDiscoveryEmptyStateView: View {
    let reason: LocalDiscoveryEmptyReason

    var body: some View {
        LocalDiscoveryTerminalStateView(symbol: "magnifyingglass",
                                        title: reason.userTitle,
                                        message: reason.userSuggestion,
                                        tint: DSColor.textTertiary)
    }
}

private struct LocalDiscoveryTerminalStateView: View {
    let symbol: String
    let title: String
    let message: String
    let tint: Color

    var body: some View {
        HStack(alignment: .top, spacing: DSSpacing.s) {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(DSFont.caption)
                    .foregroundStyle(DSColor.textPrimary)
                Text(message)
                    .font(DSFont.compactLabel)
                    .foregroundStyle(DSColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title)，\(message)")
    }
}

private struct LocalDiscoveryDeveloperDiagnosticsView: View {
    let diagnostics: LocalDiscoveryDeveloperDiagnostics

    var body: some View {
        VStack(alignment: .leading, spacing: DSSpacing.xs) {
            SectionHeader("Diagnostics")
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 130), alignment: .leading)],
                      alignment: .leading,
                      spacing: DSSpacing.xs) {
                metric("Stage", diagnostics.workflowStage)
                metric("Verifier", diagnostics.verifierVerdict ?? "unknown")
                metric("Backend", diagnostics.backend ?? "unknown")
                metric("Recovered", diagnostics.checkpointRecoveryFlag ? "true" : "false")
                metric("Tools", "\(diagnostics.toolCompletionIDs.count)")
                metric("Warnings", "\(diagnostics.warnings.count)")
            }
        }
        .padding(DSSpacing.s)
        .background(DSColor.appBackground.opacity(0.55),
                    in: RoundedRectangle(cornerRadius: DSRadius.input, style: .continuous))
        .accessibilityIdentifier("localDiscovery.developerDiagnostics")
    }

    private func metric(_ label: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(DSFont.compactLabel)
                .foregroundStyle(DSColor.textTertiary)
            Text(value)
                .font(DSFont.caption)
                .foregroundStyle(DSColor.textPrimary)
                .lineLimit(1)
                .textSelection(.enabled)
        }
    }
}
