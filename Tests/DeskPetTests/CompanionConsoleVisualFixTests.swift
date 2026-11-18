import XCTest
import CoreGraphics
import AICore
@testable import DeskPet

final class CompanionConsoleVisualFixTests: XCTestCase {
    func testCompanionConsoleWindowMetricsUseAcceptanceSize() {
        XCTAssertEqual(CompanionConsoleWindowMetrics.defaultWidth, 560)
        XCTAssertEqual(CompanionConsoleWindowMetrics.defaultHeight, 640)
        XCTAssertEqual(CompanionConsoleWindowMetrics.minWidth, 520)
        XCTAssertEqual(CompanionConsoleWindowMetrics.minHeight, 560)
        XCTAssertEqual(CompanionConsoleWindowMetrics.sidebarWidth, 148)
        XCTAssertEqual(CompanionConsoleWindowMetrics.contentMinWidth, 348)
    }

    func testWindowModeRequestsNeverFallBelowConsoleMinimum() {
        XCTAssertEqual(WindowMode.compact.size, CompanionConsoleWindowMetrics.defaultSize)
        for mode in WindowMode.allCases {
            let size = CompanionConsoleWindowMetrics.contentSize(for: mode)
            XCTAssertGreaterThanOrEqual(size.width, CompanionConsoleWindowMetrics.minWidth)
            XCTAssertGreaterThanOrEqual(size.height, CompanionConsoleWindowMetrics.minHeight)
        }
    }

    func testPageSelectionDoesNotRequestDifferentWindowSize() {
        let expected = CompanionConsoleWindowMetrics.contentSize(for: .compact)
        for section in AppSection.allCases {
            XCTAssertEqual(CompanionConsoleWindowMetrics.contentSize(for: .compact),
                           expected,
                           "section \(section.rawValue) must not drive console resizing")
        }
    }

    func testPetScaleIgnoresDecorativeHomeNestBounds() {
        let controller = PetScaleController()
        let characterFootprint = CGSize(width: 1024, height: 1536)
        let decorativeHomeBounds = CGSize(width: 480, height: 260)

        let characterOnly = controller.visualSize(for: characterFootprint)
        let withDecorations = controller.visualSize(forCharacterFootprint: characterFootprint,
                                                    ignoringDecorativeBounds: [decorativeHomeBounds])

        XCTAssertEqual(withDecorations, characterOnly)
    }

    func testProviderAndModelLabelsRemainValidForLayout() {
        XCTAssertEqual(AppSection.providers.title, "AI 设置")
        XCTAssertFalse(AppSection.providers.subtitle.isEmpty)
        for providerType in ProviderType.allCases {
            XCTAssertFalse(providerType.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        for role in ModelRole.allCases {
            XCTAssertFalse(role.rawValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    func testPermissionRowsUseStableActionLabels() {
        let labels = [
            PermissionRowActionLabels.enable,
            PermissionRowActionLabels.openSystemSettings,
            PermissionRowActionLabels.refresh,
            PermissionRowActionLabels.clipboardPicker,
        ]
        for label in labels {
            XCTAssertFalse(label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            XCTAssertGreaterThanOrEqual(label.count, 2)
        }
    }
}
