import Foundation
import AICore
import PetBrainCore

/// `ModelProviding` seam → existing chat backend. Non-isolated `Sendable`
/// wrapper that hops to the MainActor `AIServices` on demand. The
/// `@unchecked Sendable` is justified by the adapter being created and
/// held only on the main actor (verified by grep — every construction
/// site is `@MainActor`-isolated).
final class ModelAdapter: ModelProviding, @unchecked Sendable {
    private let services: AIServices
    init(_ services: AIServices) { self.services = services }
    func respond(to request: ModelRequest) async -> SemanticResponse {
        do {
            return try await services.generate(request)
        } catch {
            // P22 — `services.generate` now throws (P18.5 #3). We don't
            // re-throw because the `ModelProviding.respond` seam is
            // non-throwing by contract; instead we surface both
            // `CancellationError` and any other error as a `kind: .error`
            // SemanticResponse so the legacy `ChatModel` pipeline still
            // receives a result. Callers that want to distinguish a cancel
            // from a real failure can check `text == "已取消"` or wrap the
            // call in their own `withTaskCancellationHandler`.
            if error is CancellationError {
                return SemanticResponse(text: "已取消",
                                        kind: .error,
                                        route: .character,
                                        emotionProposal: nil,
                                        suggestions: [], viaCloud: false)
            }
            return SemanticResponse(text: "AI 暂不可用：\(error.localizedDescription)",
                                    kind: .error,
                                    route: .character,
                                    emotionProposal: nil,
                                    suggestions: [], viaCloud: false)
        }
    }
}

/// `PetBrainRepository` seam → existing MemoryModel JSON store (D6: JSON access only behind a
/// Repository). Cloud gating (blockCloud/localOnly) is enforced inside `activeHints`.
final class JSONMemoryRepository: PetBrainRepository, @unchecked Sendable {
    private let memory: MemoryModel
    init(_ memory: MemoryModel) { self.memory = memory }
    func memoryHints(forCloud: Bool) async -> [String] {
        await memory.activeHints(forCloud: forCloud)
    }
}
