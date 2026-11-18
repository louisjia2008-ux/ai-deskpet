import XCTest
import Foundation
import CryptoKit
@testable import DeskPet
@testable import AICore

/// P18.1 — AICO-003 closure.
///
/// `EncryptedBackup.seal` previously called `SecRandomCopyBytes` and
/// discarded the returned OSStatus. On RNG failure (kernel out of
/// entropy, sandbox denial) the salt would remain at 16 zero bytes
/// from the `Data(count: 16)` initializer, eliminating its entropy.
/// The HKDF salt=0 is technically valid but predictable, defeating
/// the purpose of random salt.
///
/// The fix:
///
/// 1. The OSStatus is now checked. RNG failure throws
///    `BackupError.secureRandomUnavailable(OSStatus)`.
/// 2. The encryption fails closed: NO backup package is emitted.
/// 3. A test seam (`_randomBytesOverride`) lets tests inject
///    deterministic or failing RNG sources without touching the
///    real macOS `SecRandomCopyBytes`.
///
/// These tests verify:
///
/// - Successful RNG → backup encrypted with non-zero salt
/// - Injected RNG failure → typed error, no package emitted
/// - Injected RNG returning zeros → would have been the pre-fix
///   silent state; post-fix is the same call but now observable
///   via the seam
/// - On RNG failure, the recovery path is to surface the error to
///   the user, not to fall back to a derived/constant salt
final class P18_1SecureRandomFailClosedTests: XCTestCase {

    override func setUp() async throws {
        try await super.setUp()
        // Reset any override before each test.
        EncryptedBackup._randomBytesOverride = nil
    }

    override func tearDown() async throws {
        EncryptedBackup._randomBytesOverride = nil
        try await super.tearDown()
    }

    // MARK: - Success path: real RNG, real salt

    func testSuccessfulEncryptionProducesNonZeroSalt() throws {
        let plaintext = Data("hello world".utf8)
        let package = try EncryptedBackup.seal(
            plaintext,
            password: "test-password-12345",
            manifest: ["test.txt": plaintext.count],
            version: 1)
        XCTAssertEqual(package.salt.count, 16,
            "salt must be 16 bytes (16 was the pre-fix size)")
        // We don't assert specific bytes — the real RNG may
        // produce any non-zero sequence. But we DO assert
        // that the encryption succeeds (no exception thrown).
        XCTAssertFalse(package.salt.allSatisfy { $0 == 0 },
            "salt must not be all-zero (would indicate RNG failure)")
    }

    // MARK: - Injected RNG failure

    /// Reproduces AICO-003: pre-fix, RNG failure was masked. Post-fix,
    /// RNG failure throws a typed error and NO package is emitted.
    func testRNGFailureThrowsTypedErrorNoPackage() {
        // Inject an RNG that always fails with errSecAllocate.
        EncryptedBackup._randomBytesOverride = { _ in
            throw EncryptedBackup.BackupError.secureRandomUnavailable(errSecAllocate)
        }

        let plaintext = Data("sensitive payload".utf8)
        XCTAssertThrowsError(
            try EncryptedBackup.seal(plaintext,
                                     password: "test",
                                     manifest: ["x": 1],
                                     version: 1),
            "RNG failure must propagate as a typed error, NOT silently produce a zero-salt backup"
        ) { error in
            guard case EncryptedBackup.BackupError.secureRandomUnavailable(let status) = error else {
                XCTFail("Expected secureRandomUnavailable, got \(error)")
                return
            }
            XCTAssertEqual(status, errSecAllocate)
        }
    }

    /// Pre-fix behavior under RNG failure: a 16-zero salt would be
    /// silently used and the encryption would "succeed". This test
    /// asserts the post-fix behavior: the test seam is observable
    /// and a deterministic-zero RNG still produces a successful
    /// package — but only because we explicitly accept the override
    /// (the seam does not pretend to validate the entropy; it
    /// merely lets tests inspect what the system would have done).
    func testZeroSaltViaOverrideIsObservable() throws {
        EncryptedBackup._randomBytesOverride = { count in
            Data(count: count)  // all zeros — simulate RNG that returned nothing
        }
        let plaintext = Data("payload".utf8)
        let package = try EncryptedBackup.seal(plaintext,
                                               password: "test",
                                               manifest: ["x": 1],
                                               version: 1)
        XCTAssertTrue(package.salt.allSatisfy { $0 == 0 },
            "the injected all-zero RNG must produce an all-zero salt (observable test seam)")
    }

    // MARK: - Recovery: retry after override clears

    /// After an injected failure, clearing the override must restore
    /// real RNG behavior.
    func testClearingOverrideRestoresRealRNG() throws {
        // First: inject failure.
        EncryptedBackup._randomBytesOverride = { _ in
            throw EncryptedBackup.BackupError.secureRandomUnavailable(errSecAllocate)
        }
        XCTAssertThrowsError(try EncryptedBackup.seal(Data(), password: "x",
                                                      manifest: [:], version: 1))
        // Clear and retry.
        EncryptedBackup._randomBytesOverride = nil
        let plaintext = Data("recovered".utf8)
        XCTAssertNoThrow(try EncryptedBackup.seal(plaintext, password: "x",
                                                  manifest: [:], version: 1),
                          "after clearing the override, real RNG must work")
    }

    // MARK: - Round-trip with a known-good override

    /// Verify that encryption + decryption round-trip works when the
    /// RNG is overridden to a known-deterministic source. The
    /// override is solely for salt generation; the key derivation
    /// uses HKDF so deterministic salt is reproducible.
    func testRoundTripWithDeterministicOverride() throws {
        var counter = UInt64(0)
        EncryptedBackup._randomBytesOverride = { count in
            var data = Data(count: count)
            for i in 0..<count {
                data[i] = UInt8((counter + UInt64(i)) & 0xFF)
            }
            counter += UInt64(count)
            return data
        }
        let plaintext = Data("the quick brown fox".utf8)
        let package = try EncryptedBackup.seal(plaintext,
                                               password: "test-password",
                                               manifest: ["file.txt": plaintext.count],
                                               version: 1)
        let decrypted = try EncryptedBackup.open(package, password: "test-password")
        XCTAssertEqual(decrypted, plaintext,
            "round-trip with deterministic override must preserve plaintext")
    }
}