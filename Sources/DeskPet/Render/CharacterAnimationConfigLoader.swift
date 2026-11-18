import Foundation

@MainActor
enum CharacterAnimationConfigLoader {
    private static var cached: CharacterAnimationConfig?

    static func loadDefault() -> CharacterAnimationConfig {
        if let cached { return cached }
        let decoder = JSONDecoder()
        for path in candidatePaths() {
            guard FileManager.default.fileExists(atPath: path) else { continue }
            do {
                let data = try Data(contentsOf: URL(fileURLWithPath: path))
                let config = try decoder.decode(CharacterAnimationConfig.self, from: data)
                cached = config
                NSLog("[DeskPet] Loaded character animation config from \(path)")
                return config
            } catch {
                NSLog("[DeskPet] Failed to decode character animation config at \(path): \(error)")
            }
        }
        cached = .default
        NSLog("[DeskPet] Using built-in character animation config fallback")
        return .default
    }

    static func resetForTests() {
        cached = nil
    }

    private static func candidatePaths() -> [String] {
        var paths: [String] = []
        if let bundlePath = Bundle.main.resourceURL?
            .appendingPathComponent("CharacterAnimation/default_character_animation.json").path {
            paths.append(bundlePath)
        }
        let cwd = FileManager.default.currentDirectoryPath
        paths.append(URL(fileURLWithPath: cwd)
            .appendingPathComponent("Resources/CharacterAnimation/default_character_animation.json").path)
        paths.append(URL(fileURLWithPath: cwd)
            .appendingPathComponent("DeskPet/Resources/CharacterAnimation/default_character_animation.json").path)
        return Array(NSOrderedSet(array: paths)) as? [String] ?? paths
    }
}
