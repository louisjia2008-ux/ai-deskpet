import Foundation
import PetAgentRuntime

@MainActor
final class LocalDiscoveryPresentationStore: ObservableObject {
    struct Key: Hashable {
        var taskID: UUID
        var runID: UUID
    }

    enum SourceState: Equatable {
        case idle
        case loading
        case loaded(AgentCheckpoint)
        case missing
        case failed(String)
    }

    @Published private(set) var states: [Key: SourceState] = [:]

    private let checkpointStore: AgentCheckpointStore?

    init(checkpointStore: AgentCheckpointStore?) {
        self.checkpointStore = checkpointStore
    }

    func state(taskID: UUID, runID: UUID) -> SourceState {
        states[Key(taskID: taskID, runID: runID)] ?? .idle
    }

    func load(taskID: UUID, runID: UUID) async {
        let key = Key(taskID: taskID, runID: runID)
        switch states[key] {
        case .loaded, .loading:
            return
        case .idle, .missing, .failed, .none:
            break
        }
        guard let checkpointStore else {
            states[key] = .missing
            return
        }
        states[key] = .loading
        do {
            if let checkpoint = try await checkpointStore.load(taskID: taskID, runID: runID) {
                states[key] = .loaded(checkpoint)
            } else {
                states[key] = .missing
            }
        } catch {
            states[key] = .failed(String(describing: error))
        }
    }

    func presentation(taskID: UUID,
                      runID: UUID,
                      sortMode: LocalDiscoverySortMode,
                      selectedCandidateID: LocalDiscoveryCandidateID?,
                      recoveredFromCheckpoint: Bool,
                      includeDeveloperDiagnostics: Bool) -> LocalDiscoveryPresentation? {
        guard case .loaded(let checkpoint) = state(taskID: taskID, runID: runID) else {
            return nil
        }
        return LocalDiscoveryPresentationAdapter.make(from: checkpoint,
                                                      sortMode: sortMode,
                                                      selectedCandidateID: selectedCandidateID,
                                                      recoveredFromCheckpoint: recoveredFromCheckpoint,
                                                      includeDeveloperDiagnostics: includeDeveloperDiagnostics)
    }
}
