import XCTest
@testable import PetBrainCore
@testable import AICore

final class SkillPipelineTests: XCTestCase {

    private func safeProposal() -> SkillProposal {
        SkillProposal(name: "整理周报", summary: "汇总本周任务", steps: ["读任务", "生成摘要"],
                      requiredCapabilities: ["state.read", "reminders.read"])
    }

    func testStaticCheckRejectsHighRiskCapability() {
        let p = SkillProposal(name: "危险", summary: "", steps: ["x"], requiredCapabilities: ["shell.arbitrary"])
        let r = SkillPipeline.staticCheck(p)
        XCTAssertFalse(r.passed)
        XCTAssertTrue(r.issues.contains { $0.contains("shell.arbitrary") })
    }

    func testStaticCheckRejectsUnknownCapability() {
        let p = SkillProposal(name: "x", summary: "", steps: ["x"], requiredCapabilities: ["made.up"])
        XCTAssertFalse(SkillPipeline.staticCheck(p).passed)
    }

    func testStaticCheckPassesSafeProposal() {
        XCTAssertTrue(SkillPipeline.staticCheck(safeProposal()).passed)
    }

    func testPermissionDiffSurfacesNewCapabilities() {
        let diff = SkillPipeline.permissionDiff(safeProposal(), alreadyGranted: ["state.read"])
        XCTAssertEqual(diff, ["reminders.read"])
    }

    func testCannotAutoInstallWithoutApprovalOrSandbox() {
        var reg = SkillRegistry()
        XCTAssertEqual(reg.install(safeProposal(), sandboxPassed: true, approved: false),
                       .rejected(reason: "未经用户批准"))
        XCTAssertEqual(reg.install(safeProposal(), sandboxPassed: false, approved: true),
                       .rejected(reason: "沙箱测试未通过"))
        XCTAssertTrue(reg.installed.isEmpty)
    }

    func testInstallVersioningAndRollback() {
        var reg = SkillRegistry()
        XCTAssertEqual(reg.install(safeProposal(), sandboxPassed: true, approved: true), .installed(version: 1))
        XCTAssertEqual(reg.install(safeProposal(), sandboxPassed: true, approved: true), .installed(version: 2))
        XCTAssertEqual(reg.installed["整理周报"]?.version, 2)
        XCTAssertTrue(reg.rollback("整理周报"))
        XCTAssertEqual(reg.installed["整理周报"]?.version, 1)   // back to previous version
    }
}
