import XCTest
import Foundation
import CryptoKit
@testable import AICore

/// SealedStore crypto core: envelopes, keyUnavailable fail-closed, legacy passthrough.
final class SealedStoreTests: XCTestCase {
    private func key() -> SymmetricKey { SymmetricKey(size: .bits256) }

    func testFileRoundTrip() throws {
        let k = key()
        let sealed = try SealedFile.seal(Data("hello".utf8), using: k)
        XCTAssertTrue(SealedFile.isSealed(sealed))
        XCTAssertEqual(try SealedFile.open(sealed, using: k), Data("hello".utf8))
    }

    func testFileDetectsPlaintext() {
        XCTAssertFalse(SealedFile.isSealed(Data("{\"a\":1}".utf8)))
        XCTAssertThrowsError(try SealedFile.open(Data("{\"a\":1}".utf8), using: key())) { e in
            XCTAssertEqual(e as? SealError, .notSealed)
        }
    }

    func testFileWrongKeyFailsClosed() throws {
        let sealed = try SealedFile.seal(Data("x".utf8), using: key())
        XCTAssertThrowsError(try SealedFile.open(sealed, using: key())) { e in
            XCTAssertEqual(e as? SealError, .badKey)
        }
    }

    func testFileTamperFails() throws {
        var sealed = try SealedFile.seal(Data("x".utf8), using: key())
        sealed[sealed.count - 1] ^= 0xFF
        XCTAssertThrowsError(try SealedFile.open(sealed, using: key()))
    }

    func testLineRoundTripAndLegacyPassthrough() throws {
        let k = key()
        let sealed = try SealedLine.seal(Data("{\"a\":1}".utf8), using: k)
        XCTAssertTrue(SealedLine.isSealedLine(sealed))
        XCTAssertEqual(try SealedLine.open(sealed, using: k), Data("{\"a\":1}".utf8))
        // Legacy lines pass through WITHOUT a key.
        XCTAssertEqual(try SealedLine.open(Data("{\"a\":1}".utf8), using: k), Data("{\"a\":1}".utf8))
    }

    func testVaultKeyForceUnavailable() {
        VaultKey._forceUnavailable = true
        defer { VaultKey._forceUnavailable = false }
        XCTAssertThrowsError(try VaultKey.current()) { e in
            XCTAssertEqual(e as? SealError, .keyUnavailable)
        }
        XCTAssertFalse(VaultKey.isAvailable)
    }

    func testVaultKeyOverride() throws {
        let k = key()
        VaultKey._override = k
        defer { VaultKey._override = nil }
        XCTAssertEqual(try VaultKey.current(), k)
        XCTAssertTrue(VaultKey.isAvailable)
    }
}
