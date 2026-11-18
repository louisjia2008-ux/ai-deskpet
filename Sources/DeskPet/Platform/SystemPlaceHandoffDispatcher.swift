import AppKit
import Foundation
import MapKit
import PetAgentRuntime

actor PlaceHandoffAttemptLedger {
    private var submittedAttemptIDs: Set<PlaceHandoffAttemptID> = []

    func begin(_ attemptID: PlaceHandoffAttemptID) -> Bool {
        if submittedAttemptIDs.contains(attemptID) { return false }
        submittedAttemptIDs.insert(attemptID)
        return true
    }
}

protocol ExternalURLHandlerResolving: Sendable {
    func handlerApplicationURL(for url: URL) async -> URL?
}

struct UnavailableExternalURLHandlerResolver: ExternalURLHandlerResolving {
    func handlerApplicationURL(for url: URL) async -> URL? {
        nil
    }
}

struct NSWorkspaceExternalURLHandlerResolver: ExternalURLHandlerResolving {
    func handlerApplicationURL(for url: URL) async -> URL? {
        await MainActor.run {
            NSWorkspace.shared.urlForApplication(toOpen: url)
        }
    }
}

struct ExternalURLOpenResult: Equatable, Sendable {
    var systemOpenAccepted: Bool
    var runningApplicationBundleIdentifier: String?
    var runningApplicationDisplayName: String?
    var errorCategory: String?
    var completionTimestamp: Date
}

protocol ExternalURLSystemOpening: Sendable {
    func open(_ url: URL) async -> ExternalURLOpenResult
}

struct NSWorkspaceExternalURLSystemOpener: ExternalURLSystemOpening {
    func open(_ url: URL) async -> ExternalURLOpenResult {
        await withCheckedContinuation { continuation in
            Task { @MainActor in
                let configuration = NSWorkspace.OpenConfiguration()
                configuration.activates = true
                NSWorkspace.shared.open(url, configuration: configuration) { runningApplication, error in
                    let bundleIdentifier = runningApplication?.bundleIdentifier
                    let displayName = runningApplication?.localizedName
                    let errorCategory = Self.errorCategory(error)
                    continuation.resume(returning: ExternalURLOpenResult(
                        systemOpenAccepted: errorCategory == nil && runningApplication != nil,
                        runningApplicationBundleIdentifier: bundleIdentifier,
                        runningApplicationDisplayName: displayName,
                        errorCategory: errorCategory,
                        completionTimestamp: Date()))
                }
            }
        }
    }

    private static func errorCategory(_ error: Error?) -> String? {
        guard let error else { return nil }
        let nsError = error as NSError
        let domain = AgentPrivacyRedactor.safeIdentifier(nsError.domain, fallback: "open_error")
        return "\(domain).\(nsError.code)"
    }
}

struct ExternalURLHandlerInfo: Equatable, Sendable {
    var bundleIdentifier: String?
    var displayName: String?

    init(applicationURL: URL) {
        let bundle = Bundle(url: applicationURL)
        self.bundleIdentifier = bundle?.bundleIdentifier
        self.displayName = bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String
    }
}

struct SystemPlaceHandoffDispatcher: PlaceHandoffDispatching {
    private let ledger: PlaceHandoffAttemptLedger
    private let releaseSupportPolicy: PlaceHandoffReleaseSupportPolicy
    private let urlOpener: @Sendable (URL) async -> Bool
    private let mapItemOpener: @Sendable (String, PlaceCoordinate) async -> Bool
    private let handlerResolver: ExternalURLHandlerResolving
    private let phoneOpener: ExternalURLSystemOpening

    init(ledger: PlaceHandoffAttemptLedger = PlaceHandoffAttemptLedger(),
         releaseSupportPolicy: PlaceHandoffReleaseSupportPolicy = .default,
         urlOpener: @escaping @Sendable (URL) async -> Bool = SystemPlaceHandoffDispatcher.defaultOpenURL,
         mapItemOpener: @escaping @Sendable (String, PlaceCoordinate) async -> Bool = SystemPlaceHandoffDispatcher.defaultOpenMapItem,
         handlerResolver: ExternalURLHandlerResolving = NSWorkspaceExternalURLHandlerResolver(),
         phoneOpener: ExternalURLSystemOpening = NSWorkspaceExternalURLSystemOpener()) {
        self.ledger = ledger
        self.releaseSupportPolicy = releaseSupportPolicy
        self.urlOpener = urlOpener
        self.mapItemOpener = mapItemOpener
        self.handlerResolver = handlerResolver
        self.phoneOpener = phoneOpener
    }

    func dispatch(_ request: PlaceHandoffRequest,
                  attemptID: PlaceHandoffAttemptID) async -> PlaceHandoffDispatchResult {
        guard !Task.isCancelled else {
            return PlaceHandoffDispatchResult(status: .cancelledBeforeSubmit,
                                             userMessage: "操作已取消",
                                             diagnosticSummary: "cancelled before system submit")
        }
        let boundary = PlaceHandoffDispatchBoundaryValidator.validate(request)
        guard boundary.isAvailable else {
            return PlaceHandoffDispatchResult(status: .malformedDestination,
                                             userMessage: "地点信息不可安全交给系统",
                                             diagnosticSummary: "dispatch validation blocked \(boundary.blockingReasons.map(\.rawValue).joined(separator: ","))")
        }
        let releaseSupport = releaseSupportPolicy.evaluate(request: request)
        guard releaseSupport.support.allowsDispatch else {
            return PlaceHandoffDispatchResult(
                status: .unsupportedByReleasePolicy,
                userMessage: releaseSupport.userMessage ?? "此 Mac 当前未启用电话操作",
                diagnosticSummary: releaseSupport.developerDiagnostics.joined(separator: "; "),
                submittedToSystem: false,
                externalHandlerAudit: request.action == .startPhoneHandoff
                    ? PlaceHandoffExternalHandlerAudit(
                        handlerUIVisibility: .humanNotObserved,
                        failureReason: .unsupportedByReleasePolicy)
                    : nil,
                outcomeSemantic: .unsupportedByReleasePolicy)
        }
        guard await ledger.begin(attemptID) else {
            return PlaceHandoffDispatchResult(status: .duplicateRequest,
                                             userMessage: "该操作已经提交过",
                                             diagnosticSummary: "duplicate attempt \(attemptID)")
        }

        switch request.destination {
        case .mapPlace(let name, let coordinate, let address):
            return await openMapPlace(name: name,
                                      coordinate: coordinate,
                                      address: address)
        case .directions(let name, let coordinate, let address, let origin):
            return await openDirections(destinationName: name,
                                        destinationCoordinate: coordinate,
                                        destinationAddress: address,
                                        origin: origin)
        case .website(let url, let classification):
            return await openWebsite(url, classification: classification)
        case .phone(let normalizedNumber, _):
            return await openPhone(normalizedNumber)
        }
    }

    private func openMapPlace(name: String,
                              coordinate: PlaceCoordinate?,
                              address: String?) async -> PlaceHandoffDispatchResult {
        if Task.isCancelled {
            return cancelledBeforeSubmit()
        }
        if let coordinate {
            let accepted = await mapItemOpener(name, coordinate)
            return accepted
                ? .accepted("已交给系统地图", diagnosticSummary: "MKMapItem.openInMaps accepted")
                : PlaceHandoffDispatchResult(status: .unavailableHandler,
                                             userMessage: "无法打开地图",
                                             diagnosticSummary: "MKMapItem.openInMaps returned false")
        }
        guard let url = mapsSearchURL(name: name, address: address) else {
            return malformed("missing map destination")
        }
        return await openURL(url,
                             acceptedMessage: "已交给系统地图",
                             failureMessage: "无法打开地图",
                             diagnosticPrefix: "maps search")
    }

    private func openDirections(destinationName: String,
                                destinationCoordinate: PlaceCoordinate?,
                                destinationAddress: String?,
                                origin: DirectionsOrigin) async -> PlaceHandoffDispatchResult {
        guard !Task.isCancelled else {
            return cancelledBeforeSubmit()
        }
        guard let url = directionsURL(destinationName: destinationName,
                                      destinationCoordinate: destinationCoordinate,
                                      destinationAddress: destinationAddress,
                                      origin: origin) else {
            return malformed("missing directions endpoint")
        }
        return await openURL(url,
                             acceptedMessage: "已交给系统地图",
                             failureMessage: "无法打开路线",
                             diagnosticPrefix: "maps directions")
    }

    private func openWebsite(_ url: URL,
                             classification: WebsiteClassification) async -> PlaceHandoffDispatchResult {
        guard !Task.isCancelled else {
            return cancelledBeforeSubmit()
        }
        let validation = PlaceHandoffURLValidator.validate(url.absoluteString,
                                                           classification: classification)
        guard validation.blockingReasons.isEmpty,
              let safeURL = validation.url else {
            return PlaceHandoffDispatchResult(status: .malformedDestination,
                                             userMessage: "网站地址不可安全打开",
                                             diagnosticSummary: "website validation blocked \(validation.blockingReasons.map(\.rawValue).joined(separator: ","))")
        }
        return await openURL(safeURL,
                             acceptedMessage: "已交给默认浏览器",
                             failureMessage: "无法打开网站",
                             diagnosticPrefix: "website")
    }

    private func openPhone(_ normalizedNumber: String) async -> PlaceHandoffDispatchResult {
        guard !Task.isCancelled else {
            return cancelledBeforeSubmit()
        }
        guard normalizedNumber.range(of: #"^\+?[0-9]{7,15}$"#,
                                     options: .regularExpression) != nil,
              let url = URL(string: "tel:\(normalizedNumber)") else {
            return malformed("invalid normalized phone")
        }
        guard let handlerURL = await handlerResolver.handlerApplicationURL(for: url) else {
            return PlaceHandoffDispatchResult(
                status: .unavailableHandler,
                userMessage: "此 Mac 没有可用的电话处理程序",
                diagnosticSummary: "phone handler unavailable",
                submittedToSystem: false,
                externalHandlerAudit: PlaceHandoffExternalHandlerAudit(
                    phoneHandlerRegistered: false,
                    systemOpenAccepted: false,
                    runningApplicationReturned: false,
                    handlerUIVisibility: .notApplicable,
                    failureReason: .systemHandlerUnavailable),
                outcomeSemantic: .handlerUnavailable)
        }

        let registeredHandler = ExternalURLHandlerInfo(applicationURL: handlerURL)
        let openResult = await phoneOpener.open(url)
        guard openResult.systemOpenAccepted else {
            return PlaceHandoffDispatchResult(
                status: .failed,
                userMessage: "无法打开系统电话处理程序",
                diagnosticSummary: "phone system open failed category=\(openResult.errorCategory ?? "no_running_application") handler=\(registeredHandler.bundleIdentifier ?? "unknown")",
                submittedToSystem: false,
                externalHandlerAudit: PlaceHandoffExternalHandlerAudit(
                    phoneHandlerRegistered: true,
                    registeredHandlerBundleIdentifier: registeredHandler.bundleIdentifier,
                    registeredHandlerDisplayName: registeredHandler.displayName,
                    systemOpenAccepted: false,
                    runningApplicationReturned: openResult.runningApplicationBundleIdentifier != nil,
                    returnedHandlerBundleIdentifier: openResult.runningApplicationBundleIdentifier,
                    returnedHandlerDisplayName: openResult.runningApplicationDisplayName,
                    handlerUIVisibility: .unverified,
                    openCompletionTimestamp: openResult.completionTimestamp,
                    failureReason: .systemOpenFailed,
                    openErrorCategory: openResult.errorCategory ?? "no_running_application"),
                outcomeSemantic: .systemOpenFailed)
        }

        return PlaceHandoffDispatchResult(
            status: .acceptedBySystem,
            userMessage: "已交给系统电话处理程序。DeskPet 无法确认外部处理界面是否已显示。",
            diagnosticSummary: "phone handoff accepted handler=\(openResult.runningApplicationBundleIdentifier ?? registeredHandler.bundleIdentifier ?? "unknown") systemOpen=accepted handlerUI=unverified",
            submittedToSystem: true,
            externalHandlerAudit: PlaceHandoffExternalHandlerAudit(
                phoneHandlerRegistered: true,
                registeredHandlerBundleIdentifier: registeredHandler.bundleIdentifier,
                registeredHandlerDisplayName: registeredHandler.displayName,
                systemOpenAccepted: true,
                runningApplicationReturned: openResult.runningApplicationBundleIdentifier != nil,
                returnedHandlerBundleIdentifier: openResult.runningApplicationBundleIdentifier,
                returnedHandlerDisplayName: openResult.runningApplicationDisplayName,
                handlerUIVisibility: .unverified,
                openCompletionTimestamp: openResult.completionTimestamp))
    }

    private func openURL(_ url: URL,
                         acceptedMessage: String,
                         failureMessage: String,
                         diagnosticPrefix: String) async -> PlaceHandoffDispatchResult {
        let accepted = await urlOpener(url)
        return accepted
            ? .accepted(acceptedMessage, diagnosticSummary: "\(diagnosticPrefix) handoff accepted")
            : PlaceHandoffDispatchResult(status: .unavailableHandler,
                                         userMessage: failureMessage,
                                         diagnosticSummary: "\(diagnosticPrefix) workspace.open returned false")
    }

    private func mapsSearchURL(name: String,
                               address: String?) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        let query = [name, address].compactMap { value in
            let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed?.isEmpty == false ? trimmed : nil
        }.joined(separator: " ")
        guard !query.isEmpty else { return nil }
        components?.queryItems = [URLQueryItem(name: "q", value: query)]
        return components?.url
    }

    private func directionsURL(destinationName: String,
                               destinationCoordinate: PlaceCoordinate?,
                               destinationAddress: String?,
                               origin: DirectionsOrigin) -> URL? {
        var components = URLComponents(string: "https://maps.apple.com/")
        guard let destination = destinationValue(name: destinationName,
                                                 coordinate: destinationCoordinate,
                                                 address: destinationAddress),
              let origin = originValue(origin) else {
            return nil
        }
        components?.queryItems = [
            URLQueryItem(name: "saddr", value: origin),
            URLQueryItem(name: "daddr", value: destination),
        ]
        return components?.url
    }

    private func destinationValue(name: String,
                                  coordinate: PlaceCoordinate?,
                                  address: String?) -> String? {
        if let coordinate {
            return "\(coordinate.latitude),\(coordinate.longitude)"
        }
        let value = [name, address].compactMap { item in
            let trimmed = item?.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed?.isEmpty == false ? trimmed : nil
        }.joined(separator: " ")
        return value.isEmpty ? nil : value
    }

    private func originValue(_ origin: DirectionsOrigin) -> String? {
        switch origin {
        case .currentLocation:
            return "Current Location"
        case .lastKnownLocation(let label, let coordinate, let capturedAt):
            if let coordinate,
               let capturedAt,
               Date().timeIntervalSince(capturedAt) <= 15 * 60 {
                return "\(coordinate.latitude),\(coordinate.longitude)"
            }
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .userEnteredAddress(let address):
            let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case .none:
            return nil
        }
    }

    private func malformed(_ diagnostic: String) -> PlaceHandoffDispatchResult {
        PlaceHandoffDispatchResult(status: .malformedDestination,
                                   userMessage: "地点信息不可安全交给系统",
                                   diagnosticSummary: diagnostic)
    }

    private func cancelledBeforeSubmit() -> PlaceHandoffDispatchResult {
        PlaceHandoffDispatchResult(status: .cancelledBeforeSubmit,
                                   userMessage: "操作已取消",
                                   diagnosticSummary: "cancelled before system submit")
    }

    private static func defaultOpenURL(_ url: URL) async -> Bool {
        await MainActor.run {
            NSWorkspace.shared.open(url)
        }
    }

    private static func defaultOpenMapItem(name: String,
                                           coordinate: PlaceCoordinate) async -> Bool {
        await MainActor.run {
            let placemark = MKPlacemark(coordinate: CLLocationCoordinate2D(latitude: coordinate.latitude,
                                                                           longitude: coordinate.longitude))
            let item = MKMapItem(placemark: placemark)
            item.name = name
            return item.openInMaps(launchOptions: nil)
        }
    }
}
