import Foundation
import AICore

/// Supervises the isolated `DeskPetToolRunner` (doc 03 §4) and exchanges JSON over stdio. Mirrors
/// `LLMService`: spawn on demand, correlate by id, restart on crash. Only ever sends a token +
/// minimal params — never memory/persona.
@MainActor
final class ToolRunnerService {
    private var process: Process?
    private var stdin: FileHandle?
    private var pending: [String: CheckedContinuation<ToolResult, Never>] = [:]
    private var buffer = Data()
    private let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()
    private let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private var droppedOversized = 0
    private var droppedMalformed = 0
    private let helperURL: URL
    private let workspaceRootURL: URL

    init(helperURL: URL? = nil, workspaceRoot: URL? = nil) {
        let dir = Bundle.main.executableURL?.deletingLastPathComponent()
            ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
        self.helperURL = helperURL ?? dir.appendingPathComponent("DeskPetToolRunner")
        self.workspaceRootURL = workspaceRoot ?? Self.workspaceRoot()
    }

    func invoke(_ invocation: ToolInvocation, timeout: TimeInterval = 6) async -> ToolResult {
        ensureRunning()
        guard let stdin, let data = try? encoder.encode(invocation) else {
            return ToolResult(id: invocation.id, ok: false, output: "", error: "tool runner unavailable")
        }
        // P18.5 #2 — cancel propagation. Mirror of LLMService.send: a parent
        // task cancellation must not block until the helper subprocess
        // replies or the timeout fires. Resuming a cancellation-shaped
        // result from the cancel handler clears the pending slot, so any
        // late reply from the helper is dropped by `resume(id:with:)`.
        return await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<ToolResult, Never>) in
                pending[invocation.id] = cont
                var line = data; line.append(0x0A)
                stdin.write(line)
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    self?.resume(id: invocation.id, with: ToolResult(id: invocation.id, ok: false, output: "", error: "timeout"))
                }
            }
        } onCancel: {
            // P18.5 #2 — onCancel runs in a non-isolated synchronous context;
            // hop to the main actor to clear the pending slot.
            Task { @MainActor in
                self.resume(id: invocation.id,
                            with: ToolResult(id: invocation.id, ok: false, output: "", error: "cancelled"))
            }
        }
    }

    /// The sandbox root for filesystem.workspace.* tools, handed to the runner via the environment.
    /// Created on demand under Application Support so the runner never escapes it.
    static func workspaceRoot() -> URL {
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                 appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        let root = base.appendingPathComponent("DeskPet/workspace", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func ensureRunning() {
        if let p = process, p.isRunning { return }
        guard FileManager.default.fileExists(atPath: helperURL.path) else { process = nil; return }
        let p = Process(); p.executableURL = helperURL
        var env = ProcessInfo.processInfo.environment
        try? FileManager.default.createDirectory(at: workspaceRootURL, withIntermediateDirectories: true)
        env["DESKPET_WORKSPACE"] = workspaceRootURL.path
        p.environment = env
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe; p.standardOutput = outPipe
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData; guard !chunk.isEmpty else { return }
            Task { @MainActor in self?.ingest(chunk) }
        }
        p.terminationHandler = { [weak self] _ in Task { @MainActor in self?.handleTermination() } }
        do { try p.run(); process = p; stdin = inPipe.fileHandleForWriting }
        catch { process = nil; stdin = nil }
    }

    private func ingest(_ chunk: Data) {
        buffer.append(chunk)
        if buffer.count > IPCProtocol.maxLineBytes * 2 {
            buffer.removeAll(); droppedOversized += 1; return
        }
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineLen = buffer.distance(from: buffer.startIndex, to: nl)
            if lineLen > IPCProtocol.maxLineBytes {
                buffer.removeSubrange(buffer.startIndex...nl)
                droppedOversized += 1
                continue
            }
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let r = try? decoder.decode(ToolResult.self, from: lineData) else {
                droppedMalformed += 1; continue
            }
            if r.protocolVersion > IPCProtocol.version { droppedMalformed += 1; continue }
            resume(id: r.id, with: r)
        }
    }
    private func resume(id: String, with r: ToolResult) { pending.removeValue(forKey: id)?.resume(returning: r) }
    private func handleTermination() {
        process = nil; stdin = nil; buffer.removeAll()
        let dead = pending; pending.removeAll()
        for (id, c) in dead { c.resume(returning: ToolResult(id: id, ok: false, output: "", error: "runner exited")) }
    }
}
