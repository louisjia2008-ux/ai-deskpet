import Combine
import Foundation
import AICore
import PetAgentRuntime

struct PlaceHandoffPreviewRow: Identifiable, Equatable {
    var id: String
    var label: String
    var value: String
}

struct PlaceHandoffPreview: Identifiable, Equatable {
    var id: PlaceHandoffRequestID { request.requestID }
    var request: PlaceHandoffRequest
    var candidateName: String
    var title: String
    var rows: [PlaceHandoffPreviewRow]
    var warnings: [String]
    var developerDiagnostics: [PlaceHandoffPreviewRow]

    var confirmTitle: String { request.action.confirmTitle }
}

@MainActor
protocol PlaceHandoffRecordStoring {
    func loadRecords() throws -> [PlaceHandoffExecutionRecord]
    func saveRecords(_ records: [PlaceHandoffExecutionRecord]) throws
}

@MainActor
final class PlaceHandoffJSONRecordStore: PlaceHandoffRecordStoring {
    private let fileURL: URL
    private let fileManager: FileManager

    init(fileURL: URL, fileManager: FileManager = .default) {
        self.fileURL = fileURL
        self.fileManager = fileManager
    }

    func loadRecords() throws -> [PlaceHandoffExecutionRecord] {
        guard fileManager.fileExists(atPath: fileURL.path) else { return [] }
        // D3: sealed-aware read (keyless-sealed throws, bytes kept).
        let data = try SealedStore.openForRead(Data(contentsOf: fileURL))
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let records = try decoder.decode([PlaceHandoffExecutionRecord].self, from: data)
        SealedStore.migratePlaintext(at: fileURL) { try saveRecords(records) }
        return records
    }

    func saveRecords(_ records: [PlaceHandoffExecutionRecord]) throws {
        try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(),
                                        withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(records.sorted { $0.updatedAt < $1.updatedAt })
        // D3: sealed when keyed (fail-closed on sealed-without-key).
        try SealedStore.save(data, to: fileURL)
    }
}

struct DefaultPlaceHandoffAuthorizer: PlaceHandoffAuthorizing {
    private let systemAuthorization: SystemAuthorizationProviding
    private let audit: RuntimeAuditSink
    private let clock: RuntimeClock

    init(systemAuthorization: SystemAuthorizationProviding = DefaultSystemAuthorizationPolicy(),
         audit: RuntimeAuditSink = InMemoryAuditSink(),
         clock: RuntimeClock = WallClock()) {
        self.systemAuthorization = systemAuthorization
        self.audit = audit
        self.clock = clock
    }

    func authorize(_ request: PlaceHandoffRequest) async -> PlaceHandoffPermissionDecision {
        let capabilityID = request.action.requiredCapabilityID
        guard CapabilityCatalog.lookup(capabilityID) != nil else {
            await record(.permissionDenied, request: request, reason: "unknown capability")
            return .denied("该地点操作能力未注册")
        }
        let requiresSystemAuthorization = systemAuthorization.requiresSystemAuthorization(capabilityID)
        let systemStatus = await systemAuthorization.status(for: capabilityID)
        if requiresSystemAuthorization, systemStatus != .granted {
            await record(.permissionDenied, request: request, reason: "system authorization \(systemStatus.rawValue)")
            return .denied("系统授权不可用：\(systemStatus.rawValue)")
        }
        if Task.isCancelled {
            await record(.actionCancelled, request: request, reason: "permission task cancelled")
            return .cancelled("授权检查已取消")
        }
        await record(.permissionGranted, request: request, reason: "explicit confirmation")
        return .approved
    }

    private func record(_ kind: RuntimeAuditKind,
                        request: PlaceHandoffRequest,
                        reason: String) async {
        await audit.record(RuntimeAuditEvent(kind: kind,
                                             capabilityID: request.action.requiredCapabilityID,
                                             correlationID: request.taskID,
                                             summary: RuntimeAuditRedactor.redact(reason),
                                             timestamp: clock.now()))
    }
}

struct UnavailablePlaceHandoffDispatcher: PlaceHandoffDispatching {
    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        PlaceHandoffDispatchResult(status: .unavailableHandler,
                                   userMessage: "DeskPet 不能打开这个操作，因为这台 Mac 没有可用的系统应用来处理它。你可以复制地点信息，或安装/启用相应的地图、浏览器或电话应用后重试。",
                                   diagnosticSummary: "disabled dispatcher",
                                   submittedToSystem: false)
    }
}

struct ExternalURLHandlerAvailability: Equatable, Sendable {
    var scheme: String
    var isRegistered: Bool
    var handlerBundleIdentifier: String?
    var handlerDisplayName: String?
    var resolvedAt: Date

    var snapshot: PlaceHandoffHandlerAvailabilitySnapshot {
        PlaceHandoffHandlerAvailabilitySnapshot(scheme: scheme,
                                                isRegistered: isRegistered,
                                                handlerBundleIdentifier: handlerBundleIdentifier,
                                                handlerDisplayName: handlerDisplayName,
                                                resolvedAt: resolvedAt)
    }
}

@MainActor
final class ExternalURLHandlerAvailabilityCache {
    private var resolutions: [String: ExternalURLHandlerAvailability] = [:]
    private let ttl: TimeInterval

    init(ttl: TimeInterval = 30) {
        self.ttl = max(1, ttl)
    }

    func update(url: URL,
                handlerURL: URL?,
                resolvedAt: Date) {
        guard let scheme = normalizedScheme(url) else { return }
        let handler = handlerURL.map(ExternalURLHandlerInfo.init(applicationURL:))
        resolutions[scheme] = ExternalURLHandlerAvailability(
            scheme: scheme,
            isRegistered: handlerURL != nil,
            handlerBundleIdentifier: handler?.bundleIdentifier,
            handlerDisplayName: handler?.displayName,
            resolvedAt: resolvedAt)
    }

    func availability(for url: URL, now: Date = Date()) -> ExternalURLHandlerAvailability? {
        guard let scheme = normalizedScheme(url) else { return nil }
        return availability(forScheme: scheme, now: now)
    }

    func availability(forScheme scheme: String, now: Date = Date()) -> ExternalURLHandlerAvailability? {
        let key = scheme.lowercased()
        guard let value = resolutions[key] else { return nil }
        guard now.timeIntervalSince(value.resolvedAt) <= ttl else {
            resolutions.removeValue(forKey: key)
            return nil
        }
        return value
    }

    func invalidate(url: URL) {
        guard let scheme = normalizedScheme(url) else { return }
        resolutions.removeValue(forKey: scheme)
    }

    func invalidateAll() {
        resolutions.removeAll()
    }

    private func normalizedScheme(_ url: URL) -> String? {
        url.scheme?.lowercased()
    }
}

@MainActor
final class PlaceHandoffViewModel: ObservableObject {
    @Published private(set) var records: [PlaceHandoffRequestID: PlaceHandoffExecutionRecord] = [:]
    @Published var activePreview: PlaceHandoffPreview?
    @Published private(set) var persistenceError: String?
    @Published private var externalHandlerAvailabilityRevision: Int = 0

    private let authorizer: PlaceHandoffAuthorizing
    private let dispatcher: PlaceHandoffDispatching
    private let recordStore: PlaceHandoffRecordStoring?
    private let clock: RuntimeClock
    private let handlerResolver: ExternalURLHandlerResolving
    private let handlerAvailabilityCache: ExternalURLHandlerAvailabilityCache
    private let releaseSupportPolicy: PlaceHandoffReleaseSupportPolicy
    private var runningRequestIDs: Set<PlaceHandoffRequestID> = []

    init(authorizer: PlaceHandoffAuthorizing = DefaultPlaceHandoffAuthorizer(),
         dispatcher: PlaceHandoffDispatching = UnavailablePlaceHandoffDispatcher(),
         recordStore: PlaceHandoffRecordStoring? = nil,
         clock: RuntimeClock = WallClock(),
         handlerResolver: ExternalURLHandlerResolving = UnavailableExternalURLHandlerResolver(),
         handlerAvailabilityCache: ExternalURLHandlerAvailabilityCache = ExternalURLHandlerAvailabilityCache(),
         releaseSupportPolicy: PlaceHandoffReleaseSupportPolicy = .default,
         initialRecords: [PlaceHandoffExecutionRecord] = []) {
        self.authorizer = authorizer
        self.dispatcher = dispatcher
        self.recordStore = recordStore
        self.clock = clock
        self.handlerResolver = handlerResolver
        self.handlerAvailabilityCache = handlerAvailabilityCache
        self.releaseSupportPolicy = releaseSupportPolicy
        let persisted = (try? recordStore?.loadRecords()) ?? []
        let recovered = PlaceHandoffRecoveryPolicy.recover(initialRecords + persisted,
                                                           now: clock.now())
        self.records = recovered.reduce(into: [:]) { partial, record in
            if let existing = partial[record.requestID], existing.updatedAt > record.updatedAt {
                return
            }
            partial[record.requestID] = record
        }
        if recovered != persisted || !initialRecords.isEmpty {
            persist()
        }
    }

    func prepare(action: PlaceHandoffActionKind,
                 candidate: LocalDiscoveryCandidatePresentation) {
        switch PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                      context: candidate.handoffContext,
                                                      requestedAt: clock.now()) {
        case .failure:
            return
        case .success(let request):
            let eligibility = effectiveEligibility(action: action,
                                                   context: candidate.handoffContext,
                                                   request: request)
            if !eligibility.isAvailable {
                records[request.requestID] = unavailableRecord(request: request,
                                                               eligibility: eligibility)
                persist()
                activePreview = nil
                return
            }
            if records[request.requestID] == nil {
                var record = PlaceHandoffExecutionRecord(request: request,
                                                         state: .awaitingConfirmation,
                                                         terminalMessage: "等待你的确认",
                                                         updatedAt: clock.now())
                record.auditEvents.append(auditEvent("preview.shown", request: request))
                records[request.requestID] = record
                persist()
            }
            activePreview = makePreview(request: request,
                                        candidateName: candidate.name,
                                        eligibility: eligibility)
        }
    }

    func dismissActivePreview() {
        guard let requestID = activePreview?.request.requestID else { return }
        if let record = records[requestID],
           record.state == .previewing || record.state == .awaitingConfirmation {
            cancel(requestID, reason: "确认窗口已关闭")
        }
        activePreview = nil
    }

    func cancel(_ requestID: PlaceHandoffRequestID,
                reason: String = "操作已取消") {
        guard var record = records[requestID],
              record.state == .previewing || record.state == .awaitingConfirmation else {
            activePreview = nil
            return
        }
        guard let request = activePreview?.request, request.requestID == requestID else {
            record.state = .cancelled
            record.terminalMessage = reason
            record.updatedAt = clock.now()
            records[requestID] = record
            persist()
            activePreview = nil
            return
        }
        record.state = .cancelled
        record.terminalMessage = reason
        record.updatedAt = clock.now()
        record.auditEvents.append(auditEvent("user.cancelled", request: request))
        records[requestID] = record
        persist()
        activePreview = nil
    }

    func confirm(_ requestID: PlaceHandoffRequestID) async {
        guard let request = activePreview?.request,
              request.requestID == requestID,
              var record = records[requestID] else {
            return
        }
        if runningRequestIDs.contains(requestID) || record.state == .dispatching || record.state.isTerminal {
            record.duplicateDispatchCount += 1
            record.updatedAt = clock.now()
            records[requestID] = record
            persist()
            return
        }
        guard record.state == .previewing || record.state == .awaitingConfirmation else { return }

        runningRequestIDs.insert(requestID)
        let attemptID = PlaceHandoffRequestBuilder.newAttemptID(requestID: requestID,
                                                                attemptIndex: nextAttemptIndex(record))
        let preSubmitState = record.state
        record.state = .dispatching
        record.attemptID = attemptID
        record.preSubmitState = preSubmitState
        record.terminalMessage = "正在交给系统"
        record.updatedAt = clock.now()
        record.auditEvents.append(auditEvent("dispatch.started", request: request, attemptID: attemptID))
        records[requestID] = record
        persist()

        let effectiveEligibility = effectiveEligibility(for: request)
        guard effectiveEligibility.isAvailable else {
            let status = dispatchStatus(forBlockedEligibility: effectiveEligibility)
            finish(request: request,
                   attemptID: attemptID,
                   state: terminalState(for: status),
                   permissionDecision: nil,
                   dispatchStatus: status,
                   outcomeSemantic: PlaceHandoffOutcomeSemantic(status: status),
                   terminalMessage: effectiveEligibility.primaryUserExplanation ?? "该地点操作当前不可用",
                   eventKind: "releasePolicy.blocked",
                   diagnosticSummary: releaseDiagnosticSummary(for: effectiveEligibility))
            runningRequestIDs.remove(requestID)
            return
        }

        let decision = await authorizer.authorize(request)
        guard !Task.isCancelled else {
            finish(request: request,
                   attemptID: attemptID,
                   state: .cancelled,
                   permissionDecision: "cancelled",
                   dispatchStatus: .cancelledBeforeSubmit,
                   outcomeSemantic: .userCancelled,
                   terminalMessage: "操作已取消",
                   eventKind: "permission.cancelled")
            runningRequestIDs.remove(requestID)
            return
        }

        switch decision {
        case .approved:
            updatePermission(requestID: requestID,
                             request: request,
                             attemptID: attemptID,
                             decision: "approved",
                             eventKind: "permission.approved")
        case .denied(let reason):
            finish(request: request,
                   attemptID: attemptID,
                   state: .rejected,
                   permissionDecision: "denied",
                   dispatchStatus: .rejected,
                   outcomeSemantic: .permissionRejected,
                   terminalMessage: reason,
                   eventKind: "permission.denied")
            runningRequestIDs.remove(requestID)
            return
        case .cancelled(let reason):
            finish(request: request,
                   attemptID: attemptID,
                   state: .cancelled,
                   permissionDecision: "cancelled",
                   dispatchStatus: .cancelledBeforeSubmit,
                   outcomeSemantic: .userCancelled,
                   terminalMessage: reason,
                   eventKind: "permission.cancelled")
            runningRequestIDs.remove(requestID)
            return
        }

        let result = await dispatcher.dispatch(request, attemptID: attemptID)
        let terminalState = terminalState(for: result.status)
        finish(request: request,
               attemptID: attemptID,
               state: terminalState,
               permissionDecision: "approved",
               dispatchStatus: result.status,
               outcomeSemantic: result.outcomeSemantic,
               terminalMessage: result.userMessage,
               eventKind: "dispatch.\(result.status.rawValue)",
               diagnosticSummary: result.diagnosticSummary,
               externalHandlerAudit: result.externalHandlerAudit)
        runningRequestIDs.remove(requestID)
    }

    func retry(_ requestID: PlaceHandoffRequestID) async {
        guard let request = activePreview?.request,
              request.requestID == requestID,
              let record = records[requestID],
              record.state.isTerminal else {
            return
        }
        var retryRecord = record
        retryRecord.state = .awaitingConfirmation
        retryRecord.dispatchStatus = nil
        retryRecord.terminalMessage = "等待你的确认"
        retryRecord.updatedAt = clock.now()
        retryRecord.auditEvents.append(auditEvent("retry.requested", request: request))
        records[requestID] = retryRecord
        persist()
        await confirm(requestID)
    }

    func record(for requestID: PlaceHandoffRequestID) -> PlaceHandoffExecutionRecord? {
        records[requestID]
    }

    func record(action: PlaceHandoffActionKind,
                candidate: LocalDiscoveryCandidatePresentation) -> PlaceHandoffExecutionRecord? {
        guard case .success(let request) = PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                                                  context: candidate.handoffContext,
                                                                                  requestedAt: clock.now()) else {
            return nil
        }
        return records[request.requestID]
    }

    func isDispatching(action: PlaceHandoffActionKind,
                       candidate: LocalDiscoveryCandidatePresentation) -> Bool {
        record(action: action, candidate: candidate)?.state == .dispatching
    }

    func refreshExternalHandlerEligibility(action: PlaceHandoffActionKind,
                                           candidate: LocalDiscoveryCandidatePresentation) async {
        guard case .success(let request) = PlaceHandoffRequestBuilder.makeRequest(action: action,
                                                                                  context: candidate.handoffContext,
                                                                                  requestedAt: clock.now()) else {
            return
        }
        await refreshExternalHandlerEligibility(for: request)
    }

    func refreshExternalHandlerEligibility(candidate: LocalDiscoveryCandidatePresentation) async {
        for action in PlaceHandoffActionKind.allCases {
            await refreshExternalHandlerEligibility(action: action, candidate: candidate)
        }
    }

    func invalidateExternalHandlerEligibility() {
        handlerAvailabilityCache.invalidateAll()
        externalHandlerAvailabilityRevision += 1
    }

    func refreshExternalHandlerEligibility(for request: PlaceHandoffRequest) async {
        let urls = preflightURLs(for: request)
        guard !urls.isEmpty else { return }
        for url in urls {
            await refreshExternalHandlerEligibility(for: url)
        }
    }

    func refreshExternalHandlerEligibility(for url: URL) async {
        let handlerURL = await handlerResolver.handlerApplicationURL(for: url)
        handlerAvailabilityCache.update(url: url,
                                        handlerURL: handlerURL,
                                        resolvedAt: clock.now())
        externalHandlerAvailabilityRevision += 1
    }

    func cachedExternalHandlerAvailability(for url: URL) -> ExternalURLHandlerAvailability? {
        handlerAvailabilityCache.availability(for: url, now: clock.now())
    }

    func environmentEligibility(for action: PlaceHandoffActionPresentation,
                                candidate: LocalDiscoveryCandidatePresentation) -> PlaceHandoffEligibility {
        let request = try? PlaceHandoffRequestBuilder.makeRequest(action: action.action,
                                                                  context: candidate.handoffContext,
                                                                  requestedAt: clock.now()).get()
        return effectiveEligibility(action: action.action,
                                    context: candidate.handoffContext,
                                    request: request)
    }

    private func updatePermission(requestID: PlaceHandoffRequestID,
                                  request: PlaceHandoffRequest,
                                  attemptID: PlaceHandoffAttemptID,
                                  decision: String,
                                  eventKind: String) {
        guard var record = records[requestID] else { return }
        record.permissionDecision = decision
        record.updatedAt = clock.now()
        record.auditEvents.append(auditEvent(eventKind, request: request, attemptID: attemptID))
        records[requestID] = record
        persist()
    }

    private func finish(request: PlaceHandoffRequest,
                        attemptID: PlaceHandoffAttemptID,
                        state: PlaceHandoffExecutionState,
                        permissionDecision: String?,
                        dispatchStatus: PlaceHandoffDispatchStatus?,
                        outcomeSemantic: PlaceHandoffOutcomeSemantic? = nil,
                        terminalMessage: String,
                        eventKind: String,
                        diagnosticSummary: String? = nil,
                        externalHandlerAudit: PlaceHandoffExternalHandlerAudit? = nil) {
        guard var record = records[request.requestID] else { return }
        record.state = state
        record.attemptID = attemptID
        record.permissionDecision = permissionDecision
        record.dispatchStatus = dispatchStatus
        record.outcomeSemantic = outcomeSemantic ?? dispatchStatus.map(PlaceHandoffOutcomeSemantic.init(status:))
        record.terminalMessage = terminalMessage
        record.externalHandlerAudit = externalHandlerAudit
        record.systemAcceptedAt = dispatchStatus.map(PlaceHandoffOutcomeSemantic.init(status:)) == .handedOff ? clock.now() : record.systemAcceptedAt
        record.terminalState = state
        record.updatedAt = clock.now()
        record.auditEvents.append(auditEvent(eventKind,
                                             request: request,
                                             attemptID: attemptID,
                                             diagnosticSummary: diagnosticSummary))
        records[request.requestID] = record
        persist()
    }

    private func unavailableRecord(request: PlaceHandoffRequest,
                                   eligibility: PlaceHandoffEligibility) -> PlaceHandoffExecutionRecord {
        let status = dispatchStatus(forBlockedEligibility: eligibility)
        var record = PlaceHandoffExecutionRecord(
            request: request,
            state: terminalState(for: status),
            permissionDecision: nil,
            dispatchStatus: status,
            outcomeSemantic: PlaceHandoffOutcomeSemantic(status: status),
            terminalMessage: eligibility.primaryUserExplanation ?? "该地点操作当前不可用",
            updatedAt: clock.now(),
            externalHandlerAudit: externalAudit(for: request, eligibility: eligibility),
            terminalState: terminalState(for: status))
        record.auditEvents.append(auditEvent("releasePolicy.blocked",
                                             request: request,
                                             diagnosticSummary: releaseDiagnosticSummary(for: eligibility)))
        return record
    }

    private func terminalState(for status: PlaceHandoffDispatchStatus) -> PlaceHandoffExecutionState {
        switch status {
        case .acceptedBySystem, .cancelledAfterSubmit:
            return .handedOff
        case .unsupportedByReleasePolicy, .rejected, .unavailableHandler, .malformedDestination, .duplicateRequest:
            return .rejected
        case .cancelledBeforeSubmit:
            return .cancelled
        case .failed, .timedOut:
            return .failed
        }
    }

    private func effectiveEligibility(for request: PlaceHandoffRequest) -> PlaceHandoffEligibility {
        let structural = PlaceHandoffDispatchBoundaryValidator.validate(request)
        let support = releaseSupportPolicy.evaluate(request: request,
                                                    handlerAvailability: handlerAvailabilitySnapshot(for: request))
        return structural.applyingReleaseSupport(support)
    }

    private func effectiveEligibility(action: PlaceHandoffActionKind,
                                      context: PlaceHandoffCandidateContext,
                                      request: PlaceHandoffRequest?) -> PlaceHandoffEligibility {
        let structural = PlaceHandoffEligibilityEvaluator.evaluate(action, context: context)
        let support = releaseSupportPolicy.evaluate(
            action: action,
            structuralEligibility: structural,
            handlerAvailability: request.flatMap(handlerAvailabilitySnapshot(for:)))
        return structural.applyingReleaseSupport(support)
    }

    private func handlerAvailabilitySnapshot(for request: PlaceHandoffRequest) -> PlaceHandoffHandlerAvailabilitySnapshot? {
        let snapshots = preflightSchemes(for: request).compactMap {
            handlerAvailabilityCache.availability(forScheme: $0, now: clock.now())?.snapshot
        }
        return snapshots.first(where: { !$0.isRegistered }) ?? snapshots.first
    }

    private func preflightURLs(for request: PlaceHandoffRequest) -> [URL] {
        switch request.destination {
        case .mapPlace, .directions:
            return URL(string: "maps://").map { [$0] } ?? []
        case .website(let url, _):
            guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
                return []
            }
            return [url]
        case .phone(let normalizedNumber, _):
            return URL(string: "tel:\(normalizedNumber)").map { [$0] } ?? []
        }
    }

    private func preflightSchemes(for request: PlaceHandoffRequest) -> [String] {
        preflightURLs(for: request).compactMap { $0.scheme?.lowercased() }
    }

    private func dispatchStatus(forBlockedEligibility eligibility: PlaceHandoffEligibility) -> PlaceHandoffDispatchStatus {
        if case .unavailable(let reason) = eligibility.releaseSupport {
            switch reason {
            case .humanVisibleHandlerConformanceNotCompleted, .internalConformanceOnly:
                return .unsupportedByReleasePolicy
            case .handlerUnavailable:
                return .unavailableHandler
            case .destinationValidationFailed:
                return .malformedDestination
            }
        }
        if eligibility.blockingReasons.contains(.phoneHandlerUnavailable)
            || eligibility.blockingReasons.contains(.handlerUnavailable) {
            return .unavailableHandler
        }
        return .malformedDestination
    }

    private func releaseDiagnosticSummary(for eligibility: PlaceHandoffEligibility) -> String {
        guard let reason = eligibility.releaseSupport.reason else {
            return eligibility.blockingReasons.map(\.rawValue).joined(separator: ",")
        }
        return reason.developerDiagnostic
    }

    private func externalAudit(for request: PlaceHandoffRequest,
                               eligibility: PlaceHandoffEligibility) -> PlaceHandoffExternalHandlerAudit? {
        guard request.action == .startPhoneHandoff else { return nil }
        let availability = handlerAvailabilitySnapshot(for: request)
        if case .unavailable(let reason) = eligibility.releaseSupport,
           reason == .humanVisibleHandlerConformanceNotCompleted {
            return PlaceHandoffExternalHandlerAudit(
                phoneHandlerRegistered: availability?.isRegistered,
                registeredHandlerBundleIdentifier: availability?.handlerBundleIdentifier,
                registeredHandlerDisplayName: availability?.handlerDisplayName,
                systemOpenAccepted: false,
                runningApplicationReturned: false,
                handlerUIVisibility: .humanNotObserved,
                failureReason: .unsupportedByReleasePolicy)
        }
        if availability?.isRegistered == false {
            return PlaceHandoffExternalHandlerAudit(
                phoneHandlerRegistered: false,
                systemOpenAccepted: false,
                runningApplicationReturned: false,
                handlerUIVisibility: .notApplicable,
                failureReason: .systemHandlerUnavailable)
        }
        return nil
    }

    private func nextAttemptIndex(_ record: PlaceHandoffExecutionRecord) -> Int {
        let startedCount = record.auditEvents.filter { $0.eventKind == "dispatch.started" }.count
        if startedCount > 0 { return startedCount + 1 }
        return record.attemptID == nil ? 1 : 2
    }

    private func auditEvent(_ eventKind: String,
                            request: PlaceHandoffRequest,
                            attemptID: PlaceHandoffAttemptID? = nil,
                            diagnosticSummary: String? = nil) -> PlaceHandoffAuditEvent {
        PlaceHandoffAuditEvent(eventID: "\(request.requestID)-\(eventKind)-\(UUID().uuidString)",
                               request: request,
                               attemptID: attemptID,
                               eventKind: eventKind,
                               timestamp: clock.now(),
                               userInitiated: true,
                               diagnosticSummary: diagnosticSummary)
    }

    private func makePreview(request: PlaceHandoffRequest,
                             candidateName: String,
                             eligibility: PlaceHandoffEligibility) -> PlaceHandoffPreview {
        PlaceHandoffPreview(request: request,
                            candidateName: candidateName,
                            title: previewTitle(for: request),
                            rows: previewRows(for: request),
                            warnings: warningMessages(for: eligibility),
                            developerDiagnostics: developerRows(for: request, eligibility: eligibility))
    }

    private func previewTitle(for request: PlaceHandoffRequest) -> String {
        switch request.action {
        case .openInMaps:
            return "在“\(displayName(for: request.destination))”中查看"
        case .openDirections:
            return "查看前往“\(displayName(for: request.destination))”的路线"
        case .openOfficialWebsite:
            return "打开外部网站"
        case .startPhoneHandoff:
            return "发起电话操作"
        }
    }

    private func previewRows(for request: PlaceHandoffRequest) -> [PlaceHandoffPreviewRow] {
        switch request.destination {
        case .mapPlace(_, let coordinate, let address):
            return [
                .init(id: "target", label: "目标", value: address ?? coordinate.map { "地图坐标 \($0.latitude), \($0.longitude)" } ?? "地点"),
                .init(id: "effect", label: "系统操作", value: "这会打开系统地图应用，不会开始导航。"),
            ]
        case .directions(_, let coordinate, let address, let origin):
            return [
                .init(id: "origin", label: "起点", value: origin.userLabel),
                .init(id: "destination", label: "终点", value: address ?? coordinate.map { "地图坐标 \($0.latitude), \($0.longitude)" } ?? "地点"),
                .init(id: "effect", label: "系统操作", value: "这会将起点和终点交给系统地图应用。"),
            ]
        case .website(let url, let classification):
            return [
                .init(id: "site", label: "网站", value: url.host ?? url.absoluteString),
                .init(id: "source", label: "来源", value: classification.userLabel),
                .init(id: "effect", label: "系统操作", value: "这会离开 DeskPet 并打开默认浏览器。"),
            ]
        case .phone(_, let displayNumber):
            return [
                .init(id: "number", label: "号码", value: displayNumber),
                .init(id: "effect", label: "系统操作", value: "这会交给系统电话处理程序。"),
            ]
        }
    }

    private func developerRows(for request: PlaceHandoffRequest,
                               eligibility: PlaceHandoffEligibility) -> [PlaceHandoffPreviewRow] {
        let support = releaseSupportPolicy.evaluate(request: request,
                                                    handlerAvailability: handlerAvailabilitySnapshot(for: request))
        var rows: [PlaceHandoffPreviewRow] = [
            .init(id: "action", label: "Action", value: request.action.rawValue),
            .init(id: "candidate", label: "Candidate", value: request.candidateID),
            .init(id: "request", label: "Request", value: request.requestID),
            .init(id: "policy", label: "Policy", value: eligibility.isAvailable ? "available" : "blocked"),
            .init(id: "releaseSupport", label: "Release Support", value: support.support.rawStatus),
        ]
        if let availability = support.handlerAvailability {
            rows.append(.init(id: "handlerRegistered",
                              label: "Handler Registered",
                              value: "\(availability.isRegistered)"))
            if let bundle = availability.handlerBundleIdentifier {
                rows.append(.init(id: "handlerBundle", label: "Handler Bundle", value: bundle))
            }
        }
        rows.append(contentsOf: support.developerDiagnostics.enumerated().map { index, value in
            PlaceHandoffPreviewRow(id: "releaseDiagnostic\(index)",
                                   label: "Release Diagnostic",
                                   value: value)
        })
        return rows
    }

    private func warningMessages(for eligibility: PlaceHandoffEligibility) -> [String] {
        let warningMessages = eligibility.warnings.map(\.userMessage)
        let blockingMessages = eligibility.blockingReasons.map(\.userMessage)
        return Array(Set(blockingMessages + warningMessages)).sorted()
    }

    private func phoneURL(for destination: PlaceHandoffDestination) -> URL? {
        guard case .phone(let normalizedNumber, _) = destination,
              normalizedNumber.range(of: #"^\+?[0-9]{7,15}$"#,
                                     options: .regularExpression) != nil else {
            return nil
        }
        return URL(string: "tel:\(normalizedNumber)")
    }

    private func displayName(for destination: PlaceHandoffDestination) -> String {
        switch destination {
        case .mapPlace(let name, _, _):
            return name
        case .directions(let name, _, _, _):
            return name
        case .website(let url, _):
            return url.host ?? "网站"
        case .phone(_, let displayNumber):
            return displayNumber
        }
    }

    private func persist() {
        guard let recordStore else { return }
        do {
            try recordStore.saveRecords(Array(records.values))
            persistenceError = nil
        } catch {
            persistenceError = "地点操作记录保存失败"
        }
    }
}
