import Foundation
import CryptoKit
import Security

/// Password-encrypted backup package (doc §15.2).
///
/// New packages use PBKDF2-HMAC-SHA256 with an authenticated cost parameter
/// before AES-256-GCM. Legacy HKDF packages remain readable so existing private
/// backups are not stranded. The password is never stored.
public enum EncryptedBackup {

    public enum BackupError: Error, Equatable {
        case badPassword
        case malformed
        /// P18.1 — AICO-003 closure. Raised when the secure random
        /// generator fails to produce entropy (e.g. kernel RNG
        /// unavailable). EncryptedBackup fails closed: NO backup
        /// package is emitted; the caller surfaces the error to the
        /// user. Pre-fix the OSStatus was discarded; on RNG failure
        /// the salt would remain at 16 zero bytes, eliminating its
        /// entropy.
        case secureRandomUnavailable(OSStatus)
    }

    public struct Package: Codable, Sendable, Equatable {
        public var version: Int
        public var createdAt: Date
        public var manifest: [String: Int]   // entry name → byte count, shown before restore
        public var salt: Data
        public var sealed: Data              // AES-GCM combined (nonce + ciphertext + tag)
        public var kdf: KDFParameters?

        public init(version: Int,
                    createdAt: Date,
                    manifest: [String: Int],
                    salt: Data,
                    sealed: Data,
                    kdf: KDFParameters? = nil) {
            self.version = version
            self.createdAt = createdAt
            self.manifest = manifest
            self.salt = salt
            self.sealed = sealed
            self.kdf = kdf
        }
    }

    public struct KDFParameters: Codable, Sendable, Equatable {
        public let algorithm: String
        public let iterations: Int

        public init(algorithm: String = "pbkdf2-hmac-sha256", iterations: Int) {
            self.algorithm = algorithm
            self.iterations = iterations
        }
    }

    public static let productionPBKDF2Iterations = 310_000
    /// Test-only cost seam. Production code must leave this nil.
    nonisolated(unsafe) public static var _pbkdf2IterationsOverride: Int?

    private static func deriveLegacyKey(password: String, salt: Data) -> SymmetricKey {
        let material = SymmetricKey(data: Data(password.utf8))
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: material, salt: salt,
                                      info: Data("DeskPetBackup".utf8), outputByteCount: 32)
    }

    private static func derivePBKDF2Key(password: String,
                                       salt: Data,
                                       iterations: Int) throws -> SymmetricKey {
        guard iterations >= 1_000 && iterations <= 2_000_000 else {
            throw BackupError.malformed
        }
        let passwordKey = SymmetricKey(data: Data(password.utf8))
        var firstInput = salt
        firstInput.append(contentsOf: [0, 0, 0, 1])
        var previous = Data(HMAC<SHA256>.authenticationCode(for: firstInput, using: passwordKey))
        var accumulator = [UInt8](previous)
        if iterations > 1 {
            for _ in 1..<iterations {
                previous = Data(HMAC<SHA256>.authenticationCode(for: previous, using: passwordKey))
                for index in accumulator.indices {
                    accumulator[index] ^= previous[index]
                }
            }
        }
        return SymmetricKey(data: Data(accumulator))
    }

    private struct AuthenticatedMetadata: Codable {
        let format: String
        let version: Int
        let createdAt: Date
        let manifest: [String: Int]
        let salt: Data
        let kdf: KDFParameters
    }

    private static func authenticatedMetadata(version: Int,
                                              createdAt: Date,
                                              manifest: [String: Int],
                                              salt: Data,
                                              kdf: KDFParameters) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .millisecondsSince1970
        return try encoder.encode(AuthenticatedMetadata(format: "deskpet-backup-v2",
                                                        version: version,
                                                        createdAt: createdAt,
                                                        manifest: manifest,
                                                        salt: salt,
                                                        kdf: kdf))
    }

    /// P18.1 — AICO-003 closure. Test seam: replace the system RNG
    /// with a deterministic or failing source. Production code never
    /// sets this; tests may override it temporarily.
    nonisolated(unsafe) public static var _randomBytesOverride: ((Int) throws -> Data)?

    /// P18.1 — AICO-003 closure. Internal helper that generates
    /// secure random bytes. Checks OSStatus and fails closed.
    private static func secureRandomBytes(count: Int) throws -> Data {
        if let override = _randomBytesOverride {
            return try override(count)
        }
        var bytes = Data(count: count)
        let status = bytes.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else {
                return errSecAllocate
            }
            return SecRandomCopyBytes(kSecRandomDefault, count, base)
        }
        guard status == errSecSuccess else {
            throw BackupError.secureRandomUnavailable(status)
        }
        return bytes
    }

    public static func seal(_ plaintext: Data, password: String,
                            manifest: [String: Int], version: Int) throws -> Package {
        // P18.1 — AICO-003 closure. OSStatus is now checked. RNG
        // failure throws BackupError.secureRandomUnavailable; no
        // partial package is emitted. Pre-fix the salt would silently
        // remain at 16 zero bytes, eliminating entropy.
        let salt: Data
        do {
            salt = try secureRandomBytes(count: 16)
        } catch let BackupError.secureRandomUnavailable(status) {
            throw BackupError.secureRandomUnavailable(status)
        } catch {
            throw BackupError.secureRandomUnavailable(errSecAllocate)
        }
        let createdAt = Date()
        let iterations = _pbkdf2IterationsOverride ?? productionPBKDF2Iterations
        let kdf = KDFParameters(iterations: iterations)
        let key = try derivePBKDF2Key(password: password, salt: salt, iterations: iterations)
        let aad = try authenticatedMetadata(version: version,
                                            createdAt: createdAt,
                                            manifest: manifest,
                                            salt: salt,
                                            kdf: kdf)
        let box = try AES.GCM.seal(plaintext, using: key, authenticating: aad)
        guard let combined = box.combined else { throw BackupError.malformed }
        return Package(version: version,
                       createdAt: createdAt,
                       manifest: manifest,
                       salt: salt,
                       sealed: combined,
                       kdf: kdf)
    }

    public static func open(_ package: Package, password: String) throws -> Data {
        guard let box = try? AES.GCM.SealedBox(combined: package.sealed) else { throw BackupError.malformed }
        do {
            if let kdf = package.kdf {
                guard kdf.algorithm == "pbkdf2-hmac-sha256" else {
                    throw BackupError.malformed
                }
                let key = try derivePBKDF2Key(password: password,
                                              salt: package.salt,
                                              iterations: kdf.iterations)
                let aad = try authenticatedMetadata(version: package.version,
                                                    createdAt: package.createdAt,
                                                    manifest: package.manifest,
                                                    salt: package.salt,
                                                    kdf: kdf)
                return try AES.GCM.open(box, using: key, authenticating: aad)
            }
            let key = deriveLegacyKey(password: password, salt: package.salt)
            return try AES.GCM.open(box, using: key)
        } catch let error as BackupError {
            throw error
        } catch {
            throw BackupError.badPassword   // GCM auth failure ⇒ wrong password (or tampering)
        }
    }
}
