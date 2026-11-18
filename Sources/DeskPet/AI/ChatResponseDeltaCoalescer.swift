import Foundation

@MainActor
final class ChatResponseDeltaCoalescer {
    private struct Buffer {
        var pendingText = ""
        var lastSequence = 0
        var flushScheduled = false
    }

    let flushIntervalNanoseconds: UInt64
    private var buffers: [UUID: Buffer] = [:]

    init(flushIntervalNanoseconds: UInt64 = 40_000_000) {
        self.flushIntervalNanoseconds = flushIntervalNanoseconds
    }

    func ingest(messageID: UUID, sequence: Int, text: String) -> Bool {
        guard sequence > 0, !text.isEmpty else { return false }
        var buffer = buffers[messageID] ?? Buffer()
        guard sequence > buffer.lastSequence else { return false }
        buffer.lastSequence = sequence
        buffer.pendingText += text
        let shouldSchedule = !buffer.flushScheduled
        buffer.flushScheduled = true
        buffers[messageID] = buffer
        return shouldSchedule
    }

    func flush(messageID: UUID) -> String? {
        guard var buffer = buffers[messageID] else { return nil }
        buffer.flushScheduled = false
        let text = buffer.pendingText
        buffer.pendingText = ""
        buffers[messageID] = buffer
        return text.isEmpty ? nil : text
    }

    func cancel(messageID: UUID) {
        buffers.removeValue(forKey: messageID)
    }

    func cancelAll() {
        buffers.removeAll()
    }
}
