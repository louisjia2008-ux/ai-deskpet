import XCTest
@testable import DeskPet

final class Live2DRuntimeTests: XCTestCase {
    func testFocusUsesLogicalPointsAcrossRetinaAndNegativeDisplayOrigins() {
        let rect=CGRect(x:-1440,y:100,width:400,height:600)
        XCTAssertEqual(Live2DFocusGeometry.normalized(pointer:CGPoint(x:-1240,y:400),contentRect:rect),.zero)
        XCTAssertEqual(Live2DFocusGeometry.normalized(pointer:CGPoint(x:-1040,y:700),contentRect:rect),CGPoint(x:1,y:1))
        XCTAssertEqual(Live2DFocusGeometry.normalized(pointer:CGPoint(x:-1040,y:100),contentRect:rect),CGPoint(x:1,y:-1))
        XCTAssertNil(Live2DFocusGeometry.normalized(pointer:.zero,contentRect:.zero))
    }
    func testLocalResourceContainmentRejectsModelScriptsAndTraversal() {
        let root=URL(fileURLWithPath:"/private/tmp/models")
        XCTAssertNil(Live2DLocalResources.resolved(URL(string:"deskpet://models/evil.js")!,within:root,runtime:false))
        XCTAssertNil(Live2DLocalResources.resolved(URL(string:"deskpet://models/%2e%2e/secret.json")!,within:root,runtime:false))
        XCTAssertNotNil(Live2DLocalResources.resolved(URL(string:"deskpet://models/Haru/model.model3.json")!,within:root,runtime:false))
    }
    func testEventVersionAndPayloadValidation() {
        XCTAssertNil(Live2DEvent.decode(["version":2,"type":"runtimeReady","payload":[:]]))
        XCTAssertNil(Live2DEvent.decode(["version":1,"type":"hitArea","payload":[:]]))
        XCTAssertNil(Live2DEvent.decode(["version":1,"type":"shell","payload":[:]]))
        XCTAssertEqual(Live2DEvent.decode(["version":1,"type":"hitArea","payload":["name":"Head"]])?.kind,.hitArea)
    }
}
