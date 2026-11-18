import Foundation
import AICore

// Isolated ToolRunner (doc 03 §4 / §16.4). Reads one JSON ToolInvocation per line; executes ONLY
// capabilities in its allowlist, and only when the attached short-lived token is unexpired. It has
// no access to the memory DB, persona, or long-lived credentials — it receives just a token + the
// minimal params for the current task. OS-bound capabilities (timer/reminders/calendar) run in the
// main app process (EventKit needs TCC), never here.

let decoder = JSONDecoder()
let encoder = JSONEncoder()
decoder.dateDecodingStrategy = .iso8601
encoder.dateEncodingStrategy = .iso8601

/// Workspace sandbox root, injected by ToolRunnerService. All filesystem.workspace.* paths resolve
/// inside this directory and may never escape it.
let workspaceRoot: URL? = ProcessInfo.processInfo.environment["DESKPET_WORKSPACE"]
    .map { URL(fileURLWithPath: $0, isDirectory: true) }

let maxFetchBytes = 64 * 1024

// MARK: - Tool implementations

func runWorkspaceRead(_ inv: ToolInvocation) -> ToolResult {
    guard let root = workspaceRoot else { return ToolResult(id: inv.id, ok: false, output: "", error: "workspace unavailable") }
    guard let raw = inv.params["path"] else { return ToolResult(id: inv.id, ok: false, output: "", error: "missing path") }
    do {
        let url = try WorkspacePathResolver.resolve(raw, root: root)
        let data = try Data(contentsOf: url)
        let text = String(data: data.prefix(maxFetchBytes), encoding: .utf8) ?? "<\(data.count) bytes binary>"
        return ToolResult(id: inv.id, ok: true, output: text)
    } catch let e as WorkspacePathResolver.ResolveError {
        return ToolResult(id: inv.id, ok: false, output: "", error: e.description)
    } catch {
        return ToolResult(id: inv.id, ok: false, output: "", error: "read failed: \(error.localizedDescription)")
    }
}

func runWorkspaceWrite(_ inv: ToolInvocation) -> ToolResult {
    guard let root = workspaceRoot else { return ToolResult(id: inv.id, ok: false, output: "", error: "workspace unavailable") }
    guard let raw = inv.params["path"] else { return ToolResult(id: inv.id, ok: false, output: "", error: "missing path") }
    let content = inv.params["content"] ?? ""
    do {
        let url = try WorkspacePathResolver.resolve(raw, root: root)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data(content.utf8).write(to: url, options: .atomic)
        return ToolResult(id: inv.id, ok: true, output: "wrote \(content.utf8.count) bytes to \(raw)")
    } catch let e as WorkspacePathResolver.ResolveError {
        return ToolResult(id: inv.id, ok: false, output: "", error: e.description)
    } catch {
        return ToolResult(id: inv.id, ok: false, output: "", error: "write failed: \(error.localizedDescription)")
    }
}

func execute(_ inv: ToolInvocation) -> ToolResult {
    // Local re-check (defense in depth): token not expired + capability is implemented here.
    // Also enforces token↔capability binding so a token minted for one capability
    // cannot be replayed against another.
    guard Date() < inv.token.expiresAt else {
        return ToolResult(id: inv.id, ok: false, output: "", error: "token expired")
    }
    if let bound = inv.token.capabilityID, bound != inv.capabilityID {
        return ToolResult(id: inv.id, ok: false, output: "", error: "token not bound to \(inv.capabilityID)")
    }
    guard ToolRunnerCapabilities.implemented.contains(inv.capabilityID) else {
        return ToolResult(id: inv.id, ok: false, output: "", error: "capability not implemented in runner: \(inv.capabilityID)")
    }
    switch inv.capabilityID {
    case "state.read":
        return ToolResult(id: inv.id, ok: true, output: "runner.alive pid=\(ProcessInfo.processInfo.processIdentifier)")
    case "screen.environment.read":
        return ToolResult(id: inv.id, ok: true, output: "environment: <not wired in runner>")
    case "filesystem.workspace.read":
        return runWorkspaceRead(inv)
    case "filesystem.workspace.write":
        return runWorkspaceWrite(inv)
    default:
        return ToolResult(id: inv.id, ok: false, output: "", error: "unhandled")
    }
}

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { continue }
    guard data.count <= IPCProtocol.maxLineBytes else { continue }
    let result: ToolResult
    if let inv = try? decoder.decode(ToolInvocation.self, from: data) {
        if inv.protocolVersion > IPCProtocol.version {
            result = ToolResult(id: inv.id, ok: false, output: "", error: "unsupported protocol version \(inv.protocolVersion)")
        } else {
            result = execute(inv)
        }
    } else {
        result = ToolResult(id: "unknown", ok: false, output: "", error: "malformed invocation")
    }
    if let out = try? encoder.encode(result), let s = String(data: out, encoding: .utf8) {
        print(s); fflush(stdout)
    }
}
