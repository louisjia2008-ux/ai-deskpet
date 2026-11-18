import Foundation

/// Wire protocol between the app and the out-of-process ToolRunner (doc 03 §4 / §16.4). The runner
/// only ever receives a short-lived token + the minimal params for the current task — never the
/// memory DB, persona, or long-lived credentials.
public struct ToolInvocation: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var id: String
    public var capabilityID: String
    public var token: CapabilityToken
    public var params: [String: String]      // minimal, already scoped
    public init(id: String = UUID().uuidString, capabilityID: String, token: CapabilityToken,
                params: [String: String] = [:], protocolVersion: Int = IPCProtocol.version) {
        self.protocolVersion = protocolVersion
        self.id = id; self.capabilityID = capabilityID; self.token = token; self.params = params
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = (try? c.decodeIfPresent(Int.self, forKey: .protocolVersion)) ?? 0
        id = try c.decode(String.self, forKey: .id)
        capabilityID = try c.decode(String.self, forKey: .capabilityID)
        token = try c.decode(CapabilityToken.self, forKey: .token)
        params = (try? c.decodeIfPresent([String: String].self, forKey: .params)) ?? [:]
    }
}

public struct ToolResult: Codable, Sendable, Equatable {
    public var protocolVersion: Int
    public var id: String
    public var ok: Bool
    public var output: String
    public var error: String?
    public init(id: String, ok: Bool, output: String, error: String? = nil,
                protocolVersion: Int = IPCProtocol.version) {
        self.protocolVersion = protocolVersion
        self.id = id; self.ok = ok; self.output = output; self.error = error
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = (try? c.decodeIfPresent(Int.self, forKey: .protocolVersion)) ?? 0
        id = try c.decode(String.self, forKey: .id)
        ok = (try? c.decodeIfPresent(Bool.self, forKey: .ok)) ?? false
        output = (try? c.decodeIfPresent(String.self, forKey: .output)) ?? ""
        error = try? c.decodeIfPresent(String.self, forKey: .error) ?? nil
    }
}

/// The capabilities the isolated DeskPetToolRunner actually implements. OS-bound capabilities
/// (timer/reminders/calendar) run IN-PROCESS via the CompositeToolExecutor instead — EventKit needs
/// the app's TCC identity — so they are deliberately absent here. Higher-risk executors (shell/delete)
/// are added behind their own grants in later phases.
public enum ToolRunnerCapabilities {
    public static let implemented: Set<String> = [
        "state.read", "screen.environment.read",
        "filesystem.workspace.read", "filesystem.workspace.write",
    ]

    /// The legacy native runner intentionally does not expose general-purpose networking in a
    /// public build. Hostname checks alone cannot pin the address that URLSession ultimately uses,
    /// so DNS rebinding could otherwise turn a public URL into an internal-network request. Keep
    /// the capability identifiers in the shared protocol for backwards-compatible decoding, but
    /// fail closed until the runner has an address-pinned transport.
    public static let unavailableForSecurity: Set<String> = [
        "network.fetch", "network.search",
    ]
}
