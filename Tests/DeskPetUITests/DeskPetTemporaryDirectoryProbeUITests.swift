import Foundation
import XCTest

final class DeskPetTemporaryDirectoryProbeUITests: XCTestCase {
    private let fileManager = FileManager.default
    private var evidenceRoot: URL? {
        ProcessInfo.processInfo.environment["P6_XCUITEST_EVIDENCE_DIR"].map {
            URL(fileURLWithPath: $0, isDirectory: true)
        }
    }

    func testXCTestRunnerTemporaryDirectoryWriteProbe() throws {
        let candidates: [(String, URL)] = [
            ("/tmp", URL(fileURLWithPath: "/tmp", isDirectory: true)),
            ("NSTemporaryDirectory", URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)),
            ("FileManager.temporaryDirectory", fileManager.temporaryDirectory),
            ("TMPDIR", URL(fileURLWithPath: ProcessInfo.processInfo.environment["TMPDIR"] ?? NSTemporaryDirectory(),
                           isDirectory: true)),
        ]
        var results: [ProbeResult] = []
        for (label, base) in candidates {
            results.append(runProbe(label: label, base: base))
        }
        writeEvidence("xctest_temp_probe.txt", results.map(\.line).joined(separator: "\n"))
        XCTAssertTrue(results.contains(where: { $0.succeeded }), results.map(\.line).joined(separator: "\n"))
    }

    private struct ProbeResult {
        var label: String
        var basePath: String
        var resolvedBasePath: String
        var succeeded: Bool
        var errorDomain: String?
        var errorCode: Int?

        var line: String {
            let result = succeeded ? "pass" : "fail"
            let domain = errorDomain ?? "nil"
            let code = errorCode.map(String.init) ?? "nil"
            return "label=\(label) result=\(result) base=\(basePath) resolvedBase=\(resolvedBasePath) errorDomain=\(domain) errorCode=\(code)"
        }
    }

    private func runProbe(label: String, base: URL) -> ProbeResult {
        let standardizedBase = base.standardizedFileURL
        let resolvedBase = standardizedBase.resolvingSymlinksInPath().standardizedFileURL
        let probe = standardizedBase
            .appendingPathComponent("DeskPet-XCUITest-Probe-\(UUID().uuidString)", isDirectory: true)
            .standardizedFileURL
        do {
            try fileManager.createDirectory(at: probe, withIntermediateDirectories: true)
            let file = probe.appendingPathComponent("probe")
            try Data("probe".utf8).write(to: file)
            try fileManager.removeItem(at: file)
            try fileManager.removeItem(at: probe)
            return ProbeResult(label: label,
                               basePath: standardizedBase.path,
                               resolvedBasePath: resolvedBase.path,
                               succeeded: true,
                               errorDomain: nil,
                               errorCode: nil)
        } catch {
            let nsError = error as NSError
            return ProbeResult(label: label,
                               basePath: standardizedBase.path,
                               resolvedBasePath: resolvedBase.path,
                               succeeded: false,
                               errorDomain: nsError.domain,
                               errorCode: nsError.code)
        }
    }

    private func writeEvidence(_ filename: String, _ text: String) {
        guard let evidenceRoot else { return }
        let logs = evidenceRoot.appendingPathComponent("logs", isDirectory: true)
        try? fileManager.createDirectory(at: logs, withIntermediateDirectories: true)
        try? Data((text + "\n").utf8)
            .write(to: logs.appendingPathComponent(filename), options: .atomic)
    }
}
