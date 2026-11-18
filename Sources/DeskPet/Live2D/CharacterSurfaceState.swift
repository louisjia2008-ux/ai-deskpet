import AppKit
import AICore

/// Product state stays native; no Cubism parameter or sprite clip identifiers.
struct CharacterSurfaceState: Equatable {
    var intent = CharacterAnimationIntent(state: .idle, source: .desktopInteraction)
    var activity: PetActivity = .idle
    var emotion: CharacterAnimationEmotion = .neutral
    // Preserve the AI's richer emotion until the short reaction has finished.
    var reactionEmotion: PetEmotion?
    var reactionAction: PetAction?
    var expressionPreview: String?
    var attentionTarget: CGPoint?
    var mouthOpenness: Double = 0
    var visible = true
    var dragging = false
    var movementSpeed: Double = 0
}

struct CharacterModelSelection: Codable, Equatable {
    var identity: String
    var relativePath: String
    var appearanceExpressions: [String]? = nil

    func source(within root: URL) -> URL? {
        let appearance = appearanceExpressions ?? []
        guard appearance.count <= 16, Set(appearance).count == appearance.count,
              appearance.allSatisfy({ !$0.isEmpty && $0.utf16.count <= 512 }),
              !identity.isEmpty, !relativePath.hasPrefix("/"),
              !relativePath.split(separator: "/").contains("..") else { return nil }
        var components = URLComponents()
        components.scheme = "deskpet"; components.host = "models"; components.path = "/" + relativePath
        guard let url = components.url,
              ["zip", "json"].contains(url.pathExtension.lowercased()),
              Live2DLocalResources.resolved(url, within: root, runtime: false) != nil else { return nil }
        return url
    }
}

struct CharacterModelConfiguration: Codable, Equatable {
    var version = 1
    var character: CharacterModelSelection?
    static let filename = "characters.json"
    enum ConfigurationError: LocalizedError {
        case invalid
        var errorDescription: String? { "无效的角色配置；需要 version=1 和一个有效的本机相对模型路径。" }
    }
    static func load(root: URL) throws -> Self {
        let file = root.appendingPathComponent(filename)
        guard FileManager.default.fileExists(atPath: file.path) else { return Self() }
        let data = try Data(contentsOf: file)
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ConfigurationError.invalid }
        let result: Self
        if object["version"] != nil {
            result = try JSONDecoder().decode(Self.self, from: data)
            guard result.version == 1, Set(object.keys).isSubset(of: ["version", "character"]) else { throw ConfigurationError.invalid }
        } else {
            // One-time migration: preserve the former primary identity only. Never promote the partner.
            struct Old: Decodable { var primary: CharacterModelSelection? }
            guard Set(object.keys).isSubset(of: ["primary", "companion"]), !object.isEmpty else { throw ConfigurationError.invalid }
            result = Self(character: try JSONDecoder().decode(Old.self, from: data).primary)
        }
        if let selection = result.character, selection.source(within: root) == nil { throw ConfigurationError.invalid }
        if object["version"] == nil {
            let backup = root.appendingPathComponent("characters.pre-single.json")
            if !FileManager.default.fileExists(atPath: backup.path) { try data.write(to: backup, options: .atomic) }
            try result.save(root: root)
        }
        return result
    }
    func save(root: URL) throws {
        guard version == 1, character.map({ $0.source(within: root) != nil }) ?? true else { throw ConfigurationError.invalid }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(self).write(to: root.appendingPathComponent(Self.filename), options: .atomic)
    }
}

/// A bounded low-resolution snapshot. Bottom-left native points map to top-left pixels.
struct CharacterOccupancy {
    let width: Int
    let height: Int
    let alpha: [UInt8]
    func contains(_ point: CGPoint, in frame: CGRect) -> Bool {
        guard width > 0, height > 0, alpha.count == width * height,
              frame.width > 0, frame.height > 0, frame.contains(point) else { return false }
        let x = min(width - 1, Int((point.x - frame.minX) / frame.width * CGFloat(width)))
        let y = min(height - 1, Int((frame.maxY - point.y) / frame.height * CGFloat(height)))
        return alpha[y * width + x] > 16
    }
    func visualBounds(in frame: CGRect) -> CGRect {
        guard width > 0, height > 0, alpha.count == width * height else { return .zero }
        let points = alpha.indices.filter { alpha[$0] > 16 }
        guard let first = points.first else { return .zero }
        var x0 = first % width, x1 = x0, y0 = first / width, y1 = y0
        for i in points { x0 = min(x0,i % width); x1 = max(x1,i % width); y0 = min(y0,i / width); y1 = max(y1,i / width) }
        return CGRect(x: frame.minX + CGFloat(x0) / CGFloat(width) * frame.width,
                      y: frame.maxY - CGFloat(y1 + 1) / CGFloat(height) * frame.height,
                      width: CGFloat(x1 - x0 + 1) / CGFloat(width) * frame.width,
                      height: CGFloat(y1 - y0 + 1) / CGFloat(height) * frame.height)
    }
}

struct CharacterModelCapabilities {
    var motions: [(group: String, index: Int)] = []
    var expressions: [String] = []
    var hitAreas: [String] = []
    var supportsStandardMouth = false
    var supportsStandardEyeTracking = false
    init(payload: [String: Any] = [:]) {
        motions = (payload["motions"] as? [[String: Any]] ?? []).compactMap {
            guard let group = $0["group"] as? String, let index = $0["index"] as? Int else { return nil }
            return (group, index)
        }
        expressions = payload["expressions"] as? [String] ?? []
        hitAreas = payload["hitAreas"] as? [String] ?? []
        supportsStandardMouth = payload["supportsStandardMouth"] as? Bool ?? false
        supportsStandardEyeTracking = payload["supportsStandardEyeTracking"] as? Bool ?? false
    }
    func motion(for semantic: String) -> (group: String, index: Int)? {
        // Match declared group only; never invent a walk/greeting asset.
        motions.first { $0.group.caseInsensitiveCompare(semantic) == .orderedSame }
    }
}

/// Resolve semantic product signals against expressions actually declared by this model.
/// Appearance/wardrobe toggles are never picked as random emotional reactions.
enum CharacterExpressionResolver {
    static func expression(for state: CharacterSurfaceState, available: [String]) -> String? {
        func first(_ names: [String]) -> String? {
            names.lazy.compactMap { name in available.first { $0.caseInsensitiveCompare(name) == .orderedSame } }.first
        }
        if let preview = state.expressionPreview, available.contains(preview), preview.lowercased() != "watermark" { return preview }
        if state.reactionAction == .play, let prop = first(["Playing games"]) { return prop }
        let emotion = state.reactionEmotion?.rawValue ?? state.emotion.rawValue
        switch emotion {
        case "happy": return first(["happy", "smile", "love"])
        case "shy": return first(["shy", "Blushing"])
        case "excited": return first(["excited", "Star", "happy", "smile"])
        case "sad": return first(["sad", "Cry"])
        case "annoyed": return first(["annoyed", "Angry", "Sullen face"])
        case "thinking", "curious": return first([emotion, "Leaning forward"])
        case "surprised": return first(["surprised", "surprise"])
        case "sleepy": return first(["sleepy", "sleep"])
        default: return nil
        }
    }
    static func label(_ name: String) -> String {
        let labels = ["Angry":"生气", "Blushing":"脸红", "Cry":"哭泣", "Star":"星星", "love":"爱心", "Sullen face":"黑脸", "dizzy":"晕乎乎", "Leaning forward":"探身", "Playing games":"玩游戏", "Holding neko":"抱猫", "Microphone":"拿麦克风", "small neko":"小猫", "Cat ears":"耳朵与尾巴", "Ear warm":"耳罩", "Hat":"帽子", "Tiger Tooth":"虎牙", "Down Ponytail":"下发包", "Left hair":"左发包", "Right hair":"右发包", "Left ponytail":"左马尾", "Right ponytail":"右马尾", "Long hair":"长发", "Short hair":"短发", "Sideburns":"鬓发", "Forepart":"前发", "Styling1":"造型一", "Styling2":"造型二", "Styling3":"造型三", "Flying head":"飞头一", "Flying head1":"飞头二", "Reduce":"模型缩小一", "Reduce1":"模型缩小二"]
        return labels[name] ?? name
    }
}
