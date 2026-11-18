import Foundation
import AppKit
import PetAgentRuntime
#if canImport(EventKit)
import EventKit
#endif

struct CurrentDateTimeAgentTool: AgentTool {
    typealias Input = EmptyToolInput

    static let manifest = ToolManifest(
        id: "get_current_datetime",
        displayName: "当前时间",
        shortDescription: "Get the current local date and time. Read-only and side-effect free.",
        category: .utility,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .capability("get_current_datetime"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "Current date/time fields"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 4_096),
        userVisibleExecutionSummary: "正在获取本地日期和时间…")

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let now = context.clock.now()
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = context.timeZone
        calendar.locale = context.locale
        let iso = ISO8601DateFormatter()
        iso.timeZone = context.timeZone
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let dateFormatter = DateFormatter()
        dateFormatter.locale = Locale(identifier: "en_US_POSIX")
        dateFormatter.timeZone = context.timeZone
        dateFormatter.dateFormat = "yyyy-MM-dd"
        let timeFormatter = DateFormatter()
        timeFormatter.locale = Locale(identifier: "en_US_POSIX")
        timeFormatter.timeZone = context.timeZone
        timeFormatter.dateFormat = "HH:mm:ss zzz"
        let localFormatter = DateFormatter()
        localFormatter.locale = Locale(identifier: "en_US_POSIX")
        localFormatter.timeZone = context.timeZone
        localFormatter.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
        let weekdayFormatter = DateFormatter()
        weekdayFormatter.locale = context.locale
        weekdayFormatter.timeZone = context.timeZone
        weekdayFormatter.calendar = calendar
        weekdayFormatter.dateFormat = "EEEE"
        let offsetSeconds = context.timeZone.secondsFromGMT(for: now)
        let offset = Self.utcOffsetString(seconds: offsetSeconds)
        let isoString = iso.string(from: now)
        let localDate = dateFormatter.string(from: now)
        let localTime = timeFormatter.string(from: now)
        let local = localFormatter.string(from: now)
        let weekday = weekdayFormatter.string(from: now)
        let timeZoneAbbreviation = context.timeZone.abbreviation(for: now) ?? context.timeZone.identifier
        return ToolExecutionResult(
            status: .success,
            userSafeSummary: "已获取本地日期和时间",
            structuredData: .object([
                "status": .string("success"),
                "iso8601": .string(isoString),
                "localDate": .string(localDate),
                "weekday": .string(weekday),
                "localTime": .string(localTime),
                "timeZoneIdentifier": .string(context.timeZone.identifier),
                "timeZoneAbbreviation": .string(timeZoneAbbreviation),
                "utcOffset": .string(offset),
                "localeIdentifier": .string(context.locale.identifier),
                // Compatibility aliases — this tool's output schema is provider-neutral
                // and is verified by `CurrentDateTimeObservationVerifier` regardless of
                // the underlying model brand.
                "timestamp": .string(isoString),
                "timezone": .string(context.timeZone.identifier),
                "local_time": .string(local),
                "local": .string(local),
            ]),
            modelContent: "当前本地日期和时间：\(localDate)，\(weekday)，\(localTime)，时区 \(timeZoneAbbreviation)（UTC\(offset)，\(context.timeZone.identifier)）")
    }

    private static func utcOffsetString(seconds: Int) -> String {
        let sign = seconds >= 0 ? "+" : "-"
        let absSeconds = abs(seconds)
        let hours = absSeconds / 3_600
        let minutes = (absSeconds % 3_600) / 60
        return String(format: "%@%02d:%02d", sign, hours, minutes)
    }
}

struct SystemProfileSnapshot: Sendable, Equatable {
    var macOSVersion: String
    var operatingSystemBuild: String?
    var cpuArchitecture: String
    var logicalProcessorCount: Int
    var physicalMemoryBytes: UInt64
    var localeIdentifier: String
    var timeZoneIdentifier: String
    var appVersion: String
    var appBuild: String
}

protocol SystemProfileProviding: Sendable {
    func snapshot(locale: Locale, timeZone: TimeZone) async -> SystemProfileSnapshot
}

struct LiveSystemProfileProvider: SystemProfileProviding {
    func snapshot(locale: Locale, timeZone: TimeZone) async -> SystemProfileSnapshot {
        let process = ProcessInfo.processInfo
        let info = Bundle.main.infoDictionary
        return SystemProfileSnapshot(
            macOSVersion: process.operatingSystemVersionString,
            operatingSystemBuild: nil,
            cpuArchitecture: Self.architecture,
            logicalProcessorCount: process.processorCount,
            physicalMemoryBytes: process.physicalMemory,
            localeIdentifier: locale.identifier,
            timeZoneIdentifier: timeZone.identifier,
            appVersion: info?["CFBundleShortVersionString"] as? String ?? "dev",
            appBuild: info?["CFBundleVersion"] as? String ?? "0")
    }

    private static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }
}

struct SystemProfileAgentTool: AgentTool {
    typealias Input = EmptyToolInput

    static let manifest = ToolManifest(
        id: "get_system_profile",
        displayName: "系统信息",
        shortDescription: "Read basic macOS and DeskPet runtime information without private identifiers.",
        category: .system,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .capability("get_system_profile"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "Allowlisted system profile fields"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 8_192),
        userVisibleExecutionSummary: "正在读取系统信息")

    private let provider: any SystemProfileProviding

    init(provider: any SystemProfileProviding = LiveSystemProfileProvider()) {
        self.provider = provider
    }

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let profile = await provider.snapshot(locale: context.locale, timeZone: context.timeZone)
        var data: [String: AgentJSONValue] = [
            "status": .string("success"),
            "macOSVersion": .string(profile.macOSVersion),
            "cpuArchitecture": .string(profile.cpuArchitecture),
            "logicalProcessorCount": .number(Double(profile.logicalProcessorCount)),
            "physicalMemoryBytes": .number(Double(profile.physicalMemoryBytes)),
            "localeIdentifier": .string(profile.localeIdentifier),
            "timeZoneIdentifier": .string(profile.timeZoneIdentifier),
            "deskPetAppVersion": .string(profile.appVersion),
            "deskPetBuildVersion": .string(profile.appBuild),
        ]
        if let build = profile.operatingSystemBuild {
            data["operatingSystemBuild"] = .string(build)
        }
        return ToolExecutionResult(
            status: .success,
            userSafeSummary: "已读取系统信息",
            structuredData: .object(data),
            modelContent: "macOS \(profile.macOSVersion)，CPU \(profile.cpuArchitecture)，DeskPet \(profile.appVersion) (\(profile.appBuild))")
    }
}

struct FrontmostApplicationSnapshot: Sendable, Equatable {
    var applicationName: String?
    var bundleIdentifier: String?
    var isDeskPet: Bool
    var observedAt: Date
}

protocol FrontmostApplicationProviding: Sendable {
    func frontmostApplication(observedAt: Date) async -> FrontmostApplicationSnapshot
}

struct LiveFrontmostApplicationProvider: FrontmostApplicationProviding {
    func frontmostApplication(observedAt: Date) async -> FrontmostApplicationSnapshot {
        let app = NSWorkspace.shared.frontmostApplication
        let bundleID = app?.bundleIdentifier
        return FrontmostApplicationSnapshot(
            applicationName: app?.localizedName,
            bundleIdentifier: bundleID,
            isDeskPet: bundleID == Bundle.main.bundleIdentifier,
            observedAt: observedAt)
    }
}

struct FrontmostApplicationAgentTool: AgentTool {
    typealias Input = EmptyToolInput

    static let manifest = ToolManifest(
        id: "get_frontmost_application",
        displayName: "当前应用",
        shortDescription: "Read the frontmost application name and bundle identifier without window content.",
        category: .applications,
        riskLevel: .localReadOnlyNoPrivateData,
        permissionRequirement: .capability("get_frontmost_application"),
        inputSchema: .strictEmptyObject,
        outputContract: ToolOutputContract(description: "Frontmost application allowlist fields"),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 2, maxResultBytes: 4_096),
        userVisibleExecutionSummary: "正在查看当前应用")

    private let provider: any FrontmostApplicationProviding

    init(provider: any FrontmostApplicationProviding = LiveFrontmostApplicationProvider()) {
        self.provider = provider
    }

    func execute(input: EmptyToolInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        let observedAt = context.clock.now()
        let app = await provider.frontmostApplication(observedAt: observedAt)
        let iso = ISO8601DateFormatter()
        iso.timeZone = context.timeZone
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var data: [String: AgentJSONValue] = [
            "status": .string(app.applicationName == nil ? "unavailable" : "success"),
            "isDeskPet": .bool(app.isDeskPet),
            "observedAt": .string(iso.string(from: app.observedAt)),
        ]
        if let name = app.applicationName { data["applicationName"] = .string(name) }
        if let bundleID = app.bundleIdentifier { data["bundleIdentifier"] = .string(bundleID) }
        return ToolExecutionResult(
            status: .success,
            userSafeSummary: app.applicationName == nil ? "未检测到前台应用" : "已查看当前应用",
            structuredData: .object(data),
            modelContent: app.applicationName.map { "当前前台应用：\($0)" } ?? "未检测到前台应用")
    }
}

struct CalendarEventSnapshot: Sendable, Equatable {
    var title: String
    var startDate: Date
    var endDate: Date
    var isAllDay: Bool
    var calendarDisplayName: String
}

struct CalendarEventPage: Sendable, Equatable {
    var events: [CalendarEventSnapshot]
    var truncated: Bool
}

struct CalendarDayWindow: Sendable, Equatable {
    var start: Date
    var end: Date

    init(containing date: Date, calendar: Calendar) throws {
        let start = calendar.startOfDay(for: date)
        guard let end = calendar.date(byAdding: .day, value: 1, to: start) else {
            throw CalendarEventProviderError.unavailable
        }
        self.start = start
        self.end = end
    }

    func intersects(startDate: Date, endDate: Date) -> Bool {
        startDate < end && endDate > start
    }
}

protocol CalendarEventProviding: Sendable {
    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage
}

enum CalendarEventProviderError: Error {
    case permissionMissing
    case unavailable
}

#if canImport(EventKit)
final class LiveCalendarEventProvider: CalendarEventProviding, @unchecked Sendable {
    private let store = EKEventStore()

    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        try await MainActor.run {
            let status = EKEventStore.authorizationStatus(for: .event)
            guard status == .fullAccess else { throw CalendarEventProviderError.permissionMissing }
            return try self.readEvents(containing: date, calendar: calendar, includeAllDay: includeAllDay, limit: limit)
        }
    }

    private func readEvents(containing date: Date,
                            calendar: Calendar,
                            includeAllDay: Bool,
                            limit: Int) throws -> CalendarEventPage {
        let window = try CalendarDayWindow(containing: date, calendar: calendar)
        let predicate = store.predicateForEvents(withStart: window.start, end: window.end, calendars: nil)
        let sorted = store.events(matching: predicate)
            .filter { includeAllDay || !$0.isAllDay }
            .filter { window.intersects(startDate: $0.startDate, endDate: $0.endDate) }
            .sorted {
                if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
                return ($0.title ?? "") < ($1.title ?? "")
            }
        let events = sorted.prefix(limit).map {
            CalendarEventSnapshot(title: $0.title ?? "未命名日程",
                                  startDate: $0.startDate,
                                  endDate: $0.endDate,
                                  isAllDay: $0.isAllDay,
                                  calendarDisplayName: $0.calendar.title)
        }
        return CalendarEventPage(events: Array(events), truncated: sorted.count > limit)
    }
}
#else
struct LiveCalendarEventProvider: CalendarEventProviding {
    func todayEvents(containing date: Date,
                     calendar: Calendar,
                     includeAllDay: Bool,
                     limit: Int) async throws -> CalendarEventPage {
        throw CalendarEventProviderError.unavailable
    }
}
#endif

struct TodayCalendarEventsInput: Decodable, Sendable, Equatable {
    var includeAllDay: Bool

    enum CodingKeys: String, CodingKey {
        case includeAllDay = "include_all_day"
    }

    init(includeAllDay: Bool = true) {
        self.includeAllDay = includeAllDay
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        includeAllDay = try container.decodeIfPresent(Bool.self, forKey: .includeAllDay) ?? true
    }
}

struct TodayCalendarEventsAgentTool: AgentTool {
    typealias Input = TodayCalendarEventsInput

    static let manifest = ToolManifest(
        id: "list_today_calendar_events",
        displayName: "今日日历",
        shortDescription: "List today's calendar events with minimized read-only event fields.",
        category: .calendar,
        riskLevel: .privateDataReadOnly,
        permissionRequirement: .capabilityAndSystemPermission(capabilityID: "calendar.events.read",
                                                              systemPermission: .calendarEvents),
        inputSchema: ToolJSONSchema(
            type: .object,
            properties: [
                "include_all_day": ToolJSONSchema(type: .boolean,
                                                  description: "Include all-day events. Defaults to true."),
            ],
            required: [],
            additionalProperties: false),
        outputContract: ToolOutputContract(description: "Today calendar events without notes, URLs, attendees, or EventKit IDs",
                                           maxItems: 50),
        executionCharacteristics: ToolExecutionCharacteristics(timeoutSeconds: 5, maxResultBytes: 16_384),
        userVisibleExecutionSummary: "正在查询今日日历")

    private let provider: any CalendarEventProviding
    private let maxEvents: Int

    init(provider: any CalendarEventProviding = LiveCalendarEventProvider(), maxEvents: Int = 50) {
        self.provider = provider
        self.maxEvents = max(1, maxEvents)
    }

    func execute(input: TodayCalendarEventsInput, context: ToolExecutionContext) async throws -> ToolExecutionResult {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = context.timeZone
        calendar.locale = context.locale
        let page = try await provider.todayEvents(containing: context.clock.now(),
                                                  calendar: calendar,
                                                  includeAllDay: input.includeAllDay,
                                                  limit: maxEvents)
        let iso = ISO8601DateFormatter()
        iso.timeZone = context.timeZone
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let sortedEvents = page.events.sorted {
            if $0.startDate != $1.startDate { return $0.startDate < $1.startDate }
            return $0.title < $1.title
        }
        let limitedEvents = Array(sortedEvents.prefix(maxEvents))
        let wasTruncated = page.truncated || sortedEvents.count > maxEvents
        let eventValues: [AgentJSONValue] = limitedEvents.enumerated().map { index, event in
            .object([
                "ordinal": .number(Double(index + 1)),
                "title": .string(event.title),
                "startDateTime": .string(iso.string(from: event.startDate)),
                "endDateTime": .string(iso.string(from: event.endDate)),
                "isAllDay": .bool(event.isAllDay),
                "calendarDisplayName": .string(event.calendarDisplayName),
            ])
        }
        return ToolExecutionResult(
            status: .success,
            userSafeSummary: limitedEvents.isEmpty ? "今天没有日历事件" : "已查询今日日历",
            structuredData: .object([
                "status": .string("success"),
                "events": .array(eventValues),
                "itemCount": .number(Double(limitedEvents.count)),
                "truncated": .bool(wasTruncated),
            ]),
            modelContent: limitedEvents.isEmpty ? "今天没有日历事件" : "已查询到 \(limitedEvents.count) 个今日日历事件",
            metadata: ToolExecutionMetadata(itemCount: limitedEvents.count, truncated: wasTruncated))
    }
}

struct LiveSystemAuthorizationPolicy: SystemAuthorizationProviding {
    private let fallback = DefaultSystemAuthorizationPolicy()

    func requiresSystemAuthorization(_ capabilityID: String) -> Bool {
        fallback.requiresSystemAuthorization(capabilityID)
    }

    func status(for capabilityID: String) async -> SystemAuthorizationStatus {
        guard capabilityID == "calendar.events.read" else {
            return await fallback.status(for: capabilityID)
        }
        #if canImport(EventKit)
        let status = EKEventStore.authorizationStatus(for: .event)
        switch status {
        case .fullAccess:
            return .granted
        case .writeOnly:
            return .denied
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            return .notDetermined
        default:
            return .unavailable
        }
        #else
        return .unavailable
        #endif
    }
}

@MainActor
enum CalendarPermissionRequester {
    static func requestEventsAccess() async -> SystemAuthorizationStatus {
        #if canImport(EventKit)
        let store = EKEventStore()
        let granted = (try? await store.requestFullAccessToEvents()) ?? false
        return granted ? .granted : await LiveSystemAuthorizationPolicy().status(for: "calendar.events.read")
        #else
        return .unavailable
        #endif
    }
}

enum ToolPlatformAssembly {
    static var releaseTools: [AnyAgentTool] {
        [
            AnyAgentTool(CurrentDateTimeAgentTool()),
            AnyAgentTool(SystemProfileAgentTool()),
            AnyAgentTool(FrontmostApplicationAgentTool()),
            AnyAgentTool(TodayCalendarEventsAgentTool()),
            AnyAgentTool(ApproximateLocationAgentTool()),
            AnyAgentTool(LocalPlaceSearchAgentTool()),
            AnyAgentTool(RouteDistanceEstimateAgentTool()),
            AnyAgentTool(StructuredPlaceExtractionAgentTool()),
        ]
    }

    static var releaseManifests: [ToolManifest] {
        releaseTools.map(\.manifest)
    }
}
