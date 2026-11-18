import Foundation
import CoreGraphics

/// Native semantic input. Parameter IDs and filenames stay inside the web renderer.
struct Live2DCharacterState: Equatable {
    var speaking = false
    var mouthOpenness: Double = 0
    var attention: CGPoint?
}

enum Live2DCommandType: String, Codable, CaseIterable {
    case initialize = "runtime.initialize", load = "model.load", unload = "model.unload"
    case view = "model.setView", focus = "model.setFocus", hitTest = "model.hitTest"
    case motion = "motion.play", expression = "expression.set", clearExpression = "expression.clear"
    case mouth = "speech.setMouth", speaking = "speech.setSpeaking"
    case pause = "runtime.pause", resume = "runtime.resume", fps = "runtime.setFPS"
    case capabilities = "runtime.queryCapabilities"
}

struct Live2DEvent {
    enum Kind: String {
        case runtimeReady, modelLoading, modelLoaded, modelLoadFailed, motionStarted, motionFinished
        case hitArea, runtimeError, commandCompleted, capabilities
    }
    let kind: Kind
    let id: String?
    let payload: [String: Any]
    static func decode(_ raw: Any) -> Live2DEvent? {
        guard let value = raw as? [String: Any], let version = value["version"] as? Int, version == 1,
              let type = value["type"] as? String, let kind = Kind(rawValue: type),
              let payload = value["payload"] as? [String: Any],
              JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value), data.count <= 65536 else { return nil }
        if [.runtimeError, .modelLoadFailed].contains(kind), !(payload["message"] is String) { return nil }
        if kind == .hitArea, !(payload["name"] is String) { return nil }
        if kind == .motionStarted, !(payload["group"] is String) || !(payload["index"] is Int) { return nil }
        return Live2DEvent(kind: kind, id: value["id"] as? String, payload: payload)
    }
}

enum Live2DFocusGeometry {
    /// AppKit points and CSS pixels are logical units; no backingScaleFactor multiplication.
    static func normalized(pointer: CGPoint, contentRect: CGRect) -> CGPoint? {
        guard contentRect.width > 0, contentRect.height > 0,
              [pointer.x,pointer.y,contentRect.minX,contentRect.minY,contentRect.width,contentRect.height].allSatisfy({ $0.isFinite }) else { return nil }
        return CGPoint(x: min(1,max(-1,2*(pointer.x-contentRect.midX)/contentRect.width)),
                       y: min(1,max(-1,2*(pointer.y-contentRect.midY)/contentRect.height)))
    }
}
