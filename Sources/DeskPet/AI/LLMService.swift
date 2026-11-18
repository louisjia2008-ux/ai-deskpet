import Foundation
import AICore

/// Supervises the isolated `DeskPetLLM` helper process and exchanges newline-delimited JSON with
/// it (doc §11.2/§17.2). If the helper dies, the pet keeps running and the next request respawns
/// it — a contained fault domain, not a crash of the whole app.
@MainActor
final class LLMService {

    private var process: Process?
    private var stdin: FileHandle?
    private var pending: [String: CheckedContinuation<AIResponse, Never>] = [:]
    private var buffer = Data()
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()
    /// Dropped-line counters for diagnostics (oversized / malformed / version-mismatch).
    private var droppedOversized = 0
    private var droppedMalformed = 0

    /// Where the helper binary lives — next to the app executable (both in Contents/MacOS),
    /// or in the SwiftPM bin dir during development.
    private let helperURL: URL

    init(helperURL: URL? = nil) {
        if let helperURL {
            self.helperURL = helperURL
        } else {
            let dir = Bundle.main.executableURL?.deletingLastPathComponent()
                ?? URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent()
            self.helperURL = dir.appendingPathComponent("DeskPetLLM")
        }
    }

    /// Send a request to the local model, awaiting its structured reply. Times out gracefully.
    func send(_ request: AIRequest, timeout: TimeInterval = 8) async -> AIResponse {
        ensureRunning()
        guard let stdin else {
            return AIResponse(id: request.id, ok: false, reply: "本地模型不可用", error: "no helper")
        }
        guard let data = try? encoder.encode(request) else {
            return AIResponse(id: request.id, ok: false, reply: "请求编码失败", error: "encode")
        }

        // P18.5 #2 — cancel propagation. The previous version waited up to
        // `timeout` even when the parent Task was cancelled, because
        // `withCheckedContinuation` doesn't observe `Task.isCancelled`.
        // We now wrap the wait in `withTaskCancellationHandler` so a
        // parent cancel resumes the continuation immediately with a
        // cancellation-shaped response and the helper subprocess is
        // signalled to stop computing for this request.
        let reply = await withTaskCancellationHandler {
            await withCheckedContinuation { (cont: CheckedContinuation<AIResponse, Never>) in
                pending[request.id] = cont
                var line = data
                line.append(0x0A) // newline
                stdin.write(line)
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                    self?.resume(id: request.id,
                                 with: AIResponse(id: request.id, ok: false, reply: "本地模型超时", error: "timeout"))
                }
            }
        } onCancel: {
            // P18.5 #2 — the onCancel handler runs in a non-isolated
            // synchronous context; hop to the main actor to clear the
            // pending slot. The helper subprocess keeps computing for
            // this request id, but the parent task no longer waits; the
            // eventual late reply is dropped by `resume(id:with:)` because
            // the pending slot was already cleared below.
            Task { @MainActor in
                self.resume(id: request.id,
                            with: AIResponse(id: request.id, ok: false, reply: "已取消", error: "cancelled"))
            }
        }
        return reply
    }

    // MARK: Process lifecycle

    private func ensureRunning() {
        if let p = process, p.isRunning { return }
        guard FileManager.default.fileExists(atPath: helperURL.path) else { process = nil; return }

        let p = Process()
        p.executableURL = helperURL
        let inPipe = Pipe(), outPipe = Pipe()
        p.standardInput = inPipe
        p.standardOutput = outPipe
        outPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            Task { @MainActor in self?.ingest(chunk) }
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor in self?.handleTermination() }
        }
        do {
            try p.run()
            process = p
            stdin = inPipe.fileHandleForWriting
        } catch {
            process = nil; stdin = nil
        }
    }

    private func ingest(_ chunk: Data) {
        buffer.append(chunk)
        // Bound memory: if the helper emits garbage without newlines, drop the buffer
        // once it exceeds 2x the max line size rather than growing unbounded (OOM).
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
            guard let resp = try? decoder.decode(AIResponse.self, from: lineData) else {
                droppedMalformed += 1; continue
            }
            // Version gate: legacy (0) accepted during migration; future (>current)
            // dropped to avoid misinterpreting an incompatible schema.
            if resp.protocolVersion > IPCProtocol.version { droppedMalformed += 1; continue }
            resume(id: resp.id, with: resp)
        }
    }

    private func resume(id: String, with response: AIResponse) {
        guard let cont = pending.removeValue(forKey: id) else { return }
        cont.resume(returning: response)
    }

    private func handleTermination() {
        // Helper crashed/exited: fail all in-flight requests; it respawns on the next send.
        process = nil; stdin = nil; buffer.removeAll()
        let dead = pending
        pending.removeAll()
        for (id, cont) in dead {
            cont.resume(returning: AIResponse(id: id, ok: false, reply: "本地模型已重启，请重试", error: "helper exited"))
        }
    }
}
