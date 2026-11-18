import XCTest
@testable import DeskPet

// Public-source regression: only the production character configuration is a
// valid default. Third-party demo assets are not part of the repository.

@MainActor
final class CharacterAnimationConfigLoaderTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        CharacterAnimationConfigLoader.resetForTests()
    }

    override func tearDown() async throws {
        CharacterAnimationConfigLoader.resetForTests()
        try await super.tearDown()
    }

    func test_loadDefault_returnsProductionConfig() {
        let config = CharacterAnimationConfigLoader.loadDefault()
        XCTAssertEqual(config.asset.name, "character_anchor_rgba_v3.png",
                       "The loader must select the project-owned production asset.")
        XCTAssertTrue(config.asset.relativePath.contains("Default"),
                       "Production asset path should live under Characters/Default/")
    }
}
