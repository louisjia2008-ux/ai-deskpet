import Foundation
import AICore

// Isolated LLM helper (doc §11.2/§17.2). Reads one JSON AIRequest per line from stdin and writes
// one JSON AIResponse per line to stdout. Crashing here cannot take down the desktop pet — the
// app supervises and restarts this process. A real on-device model replaces LocalEngine later.

let engine = LocalEngine()
let encoder = JSONEncoder()
let decoder = JSONDecoder()

while let line = readLine(strippingNewline: true) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { continue }
    // Bound oversized lines (DoS guard shared with app-side ingest).
    guard data.count <= IPCProtocol.maxLineBytes else { continue }

    let response: AIResponse
    if let req = try? decoder.decode(AIRequest.self, from: data) {
        // Reject future protocol versions rather than misinterpreting them.
        if req.protocolVersion > IPCProtocol.version {
            response = AIResponse(id: req.id, ok: false, reply: "",
                                  error: "unsupported protocol version \(req.protocolVersion)")
        } else {
            response = engine.respond(to: req)
        }
    } else {
        response = AIResponse(id: "unknown", ok: false, reply: "",
                              error: "malformed request")
    }

    if let out = try? encoder.encode(response), let s = String(data: out, encoding: .utf8) {
        print(s)
        fflush(stdout)
    }
}
