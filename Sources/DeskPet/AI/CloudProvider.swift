import Foundation
import AICore

/// Placeholder for an optional cloud model (doc §11.2 云端可选). It performs NO network I/O —
/// no data leaves the machine — so "never auto-upload" holds by construction. A real provider
/// slots in behind this `send` contract later, still gated by CloudAuthorization + per-use
/// confirmation for screenshots/files (doc §11.3). Like LocalEngine, this validates the pipeline.
@MainActor
final class CloudProvider {
    func send(_ request: AIRequest) async -> AIResponse {
        try? await Task.sleep(nanoseconds: 250_000_000)
        return AIResponse(id: request.id, ok: true,
                          reply: "（云端模型占位）我会更仔细地分析这个问题：\(request.prompt.prefix(40))",
                          emotion: .thinking, action: .read,
                          suggestions: ["要我整理成笔记吗？"])
    }
}
