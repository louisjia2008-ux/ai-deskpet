import Foundation
import CryptoKit
import Security

/// At-rest encryption for DeskPet's local stores (D3 lightweight step).
/// Whole-file (`SealedFile`) and per-line (`SealedLine`) AES-GCM-256 envelopes
/// keyed by a Keychain-held data key (`VaultKey`). Fail-closed: a missing key
/// or bad password-equivalent throws — callers surface it through their
/// existing observable-persistence errors (P18.6) and keep data in memory.
///
/// Envelope versions:
/// - file: `DPET1\n` + base64(nonce+ciphertext+tag)
/// - line: `~v1.` + base64(nonce+ciphertext+tag) + `\n` (caller appends newline)
/// Legacy plaintext is detected by the missing prefix so first-launch
/// migration can decode-then-reseal. Rollback material is itself sealed.

public enum SealError: Error, Equatable, Sendable {
    case notSealed
    case badKey
    case malformed
    case keyUnavailable
}

/// Device data-protection key. Generated once into the login Keychain
/// (this-device-only, never synced); every sealed store shares it so there is
/// exactly one secret to protect and rotate.
public enum VaultKey {
    private static let service = "ai.deskpet.vaultkey"
    private static let account = "data-protection-v1"

    /// Test seam: bypasses the Keychain entirely (mirrors
    /// `EncryptedBackup._randomBytesOverride` precedent). Production never sets this.
    nonisolated(unsafe) public static var _override: SymmetricKey?
    /// Test seam: forces `.keyUnavailable` to exercise fail-closed paths.
    nonisolated(unsafe) public static var _forceUnavailable = false

    /// The shared data key, loading or creating it. Throws `.keyUnavailable`
    /// when the Keychain is unreachable (e.g. ad-hoc-signed dev builds where
    /// Keychain persistence is not guaranteed — see build_app.sh).
    public static func current() throws -> SymmetricKey {
        if _forceUnavailable { throw SealError.keyUnavailable }
        if let o = _override { return o }
        if let existing = lookup() { return existing }
        let fresh = SymmetricKey(size: .bits256)
        try store(fresh)
        return fresh
    }

    /// Non-throwing probe for UI/diagnostics ("钥匙不可用" surfacing).
    public static var isAvailable: Bool {
        if _forceUnavailable { return false }
        if _override != nil { return true }
        return lookup() != nil || canWriteKeychain()
    }

    // MARK: - Keychain

    private static func query() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    private static func lookup() -> SymmetricKey? {
        var q = query()
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        q[kSecReturnData as String] = true
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, data.count == 32 else { return nil }
        return SymmetricKey(data: data)
    }

    private static func store(_ key: SymmetricKey) throws {
        let data = key.withUnsafeBytes { Data($0) }
        var add = query()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status == errSecDuplicateItem {
            // Lost a create race — the existing key wins; verify readability.
            guard lookup() != nil else { throw SealError.keyUnavailable }
            return
        }
        guard status == errSecSuccess else { throw SealError.keyUnavailable }
    }

    private static func canWriteKeychain() -> Bool {
        // Cheap probe that never writes: a lookup miss is inconclusive, so
        // report available (first launch will create). Only hard failures
        // (e.g. sandbox denial) surface via current() throwing.
        true
    }
}

/// Whole-file envelope.
public enum SealedFile {
    static let magic = "DPET1\n"

    public static func seal(_ plaintext: Data, using key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: key)
        guard let combined = box.combined else { throw SealError.malformed }
        return Data((magic + combined.base64EncodedString()).utf8)
    }

    public static func isSealed(_ data: Data) -> Bool {
        data.starts(with: Data(magic.utf8))
    }

    /// Decrypts. Throws `.notSealed` for legacy plaintext (caller migrates),
    /// `.badKey`/`.malformed` for corrupt/tampered input.
    public static func open(_ data: Data, using key: SymmetricKey) throws -> Data {
        guard isSealed(data) else { throw SealError.notSealed }
        let b64 = data.dropFirst(magic.utf8.count)
        guard let combined = Data(base64Encoded: Data(b64)),
              let box = try? AES.GCM.SealedBox(combined: combined) else {
            throw SealError.malformed
        }
        do {
            return try AES.GCM.open(box, using: key)
        } catch {
            throw SealError.badKey
        }
    }
}

/// Per-line envelope for JSONL stores (activity / run events / audit / inbox).
public enum SealedLine {
    static let prefix = "~v1."

    public static func seal(_ plaintext: Data, using key: SymmetricKey) throws -> Data {
        let box = try AES.GCM.seal(plaintext, using: key)
        guard let combined = box.combined else { throw SealError.malformed }
        return Data((prefix + combined.base64EncodedString()).utf8)
    }

    public static func isSealedLine(_ line: Data) -> Bool {
        line.starts(with: Data(prefix.utf8))
    }

    /// Auto-detect: sealed lines decrypt (throwing `.badKey`/`.malformed` on
    /// failure); legacy plaintext lines pass through untouched for migration.
    public static func open(_ line: Data, using key: SymmetricKey) throws -> Data {
        guard isSealedLine(line) else { return line }
        let b64 = line.dropFirst(prefix.utf8.count)
        guard let combined = Data(base64Encoded: Data(b64)),
              let box = try? AES.GCM.SealedBox(combined: combined) else {
            throw SealError.malformed
        }
        do {
            return try AES.GCM.open(box, using: key)
        } catch {
            throw SealError.badKey
        }
    }
}

/// Best-effort OS file protection (complete-until-first-unlock + owner-only
/// posix bits). Defense in depth under the AES envelopes; silently ignored
/// where the platform does not enforce it.
public enum FileProtection {
    @discardableResult
    public static func apply(to url: URL) -> Bool {
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: url.path)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: url.path)
            return true
        } catch {
            return false
        }
    }
}

/// Bytes-level store bridge shared by DeskPet's JSON/SQLite/JSONL stores and
/// the PetAgentRuntime durable kernel (both depend on AICore).
///
/// Key wiring (explicit, test-safe):
/// - Unit tests explicitly use `.legacyTesting` to exercise pre-encryption
///   fixtures.
/// - Production sets `.encryptionRequired` before resolving the Keychain
///   key. No key means every disk write fails closed.
///
/// Migration: legacy plaintext decodes as before, then re-saves sealed with a
/// single sealed `.pre-seal-backup` kept beside the original.
public enum SealedStore {
    public enum PersistencePolicy: Sendable, Equatable {
        case legacyTesting
        case encryptionRequired
    }

    private static let lock = NSLock()
    // Guarded by `lock`; nonisolated(unsafe) satisfies Swift 6 global checks
    // (same pattern as VaultKey._override).
    nonisolated(unsafe) private static var _cachedKey: SymmetricKey?
    nonisolated(unsafe) private static var _persistencePolicy: PersistencePolicy = .legacyTesting
    /// Set once at app launch (main thread) or per-test. Nil = legacy mode.
    public static var cachedKey: SymmetricKey? {
        get { lock.withLock { _cachedKey } }
        set { lock.withLock { _cachedKey = newValue } }
    }
    public static var persistencePolicy: PersistencePolicy {
        get { lock.withLock { _persistencePolicy } }
        set { lock.withLock { _persistencePolicy = newValue } }
    }

    public enum LoadState {
        case absent
        /// Plaintext bytes + whether they arrived sealed (post-decrypt).
        case data(Data, sealed: Bool)
    }

    /// Reads raw bytes, decrypting sealed files. Legacy plaintext passes
    /// through without needing a key (migration reads work keyless). Sealed
    /// files without a key throw `.keyUnavailable` — callers return empty
    /// WITHOUT quarantining (the bytes stay for later recovery).
    public static func load(at url: URL,
                            fileManager: FileManager = .default) throws -> LoadState {
        guard fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url), !data.isEmpty else {
            return .absent
        }
        guard SealedFile.isSealed(data) else { return .data(data, sealed: false) }
        guard let key = cachedKey else { throw SealError.keyUnavailable }
        return .data(try SealedFile.open(data, using: key), sealed: true)
    }

    /// Seals + atomically writes + applies OS protection. Production refuses
    /// all keyless writes. Legacy plaintext output exists only for explicit
    /// test compatibility.
    public static func save(_ plaintext: Data, to url: URL,
                            fileManager: FileManager = .default) throws {
        if let key = cachedKey {
            try SealedFile.seal(plaintext, using: key).write(to: url, options: .atomic)
            FileProtection.apply(to: url)
            return
        }
        if persistencePolicy == .encryptionRequired {
            throw SealError.keyUnavailable
        }
        if let existing = try? Data(contentsOf: url), SealedFile.isSealed(existing) {
            throw SealError.keyUnavailable
        }
        try plaintext.write(to: url, options: .atomic)
        FileProtection.apply(to: url)
    }

    /// Keeps a single encrypted backup of the pre-seal bytes; never overwrites
    /// it, so repeated migrations cannot bury the original.
    public static func backupOnce(at url: URL,
                                  fileManager: FileManager = .default) throws {
        let backup = url.appendingPathExtension("pre-seal-backup")
        guard fileManager.fileExists(atPath: url.path),
              !fileManager.fileExists(atPath: backup.path) else { return }
        guard let key = cachedKey else { throw SealError.keyUnavailable }
        let plaintext = try Data(contentsOf: url)
        let sealed = try SealedFile.seal(plaintext, using: key)
        try sealed.write(to: backup, options: [.atomic])
        guard FileProtection.apply(to: backup) else {
            try? fileManager.removeItem(at: backup)
            throw SealError.keyUnavailable
        }
    }

    /// Re-saves plaintext bytes sealed when a key is wired (migration write
    /// path). No-op when keyless or already sealed.
    public static func migratePlaintext(at url: URL, resave: () throws -> Void) {
        guard cachedKey != nil else { return }
        guard let data = try? Data(contentsOf: url),
              !SealedFile.isSealed(data) else { return }
        do {
            try backupOnce(at: url)
            try resave()
            guard let migrated = try? Data(contentsOf: url),
                  SealedFile.isSealed(migrated) else {
                return
            }
        } catch {
            return
        }
    }

    // MARK: - JSONL lines

    /// Seals one JSON line (no trailing newline; caller appends it).
    public static func sealLine(_ json: Data) throws -> Data {
        if let key = cachedKey {
            return try SealedLine.seal(json, using: key)
        }
        guard persistencePolicy == .legacyTesting else {
            throw SealError.keyUnavailable
        }
        return json
    }

    /// Opens one line: sealed lines decrypt (key required), legacy plaintext
    /// lines pass through keyless so mixed old/new files read uniformly.
    public static func openLine(_ line: Data) throws -> Data {
        guard SealedLine.isSealedLine(line) else { return line }
        guard let key = cachedKey else { throw SealError.keyUnavailable }
        return try SealedLine.open(line, using: key)
    }

    /// Seals bytes for a custom atomic writer (fsync tmp+replace paths that
    /// cannot use `save`). Keyless + existing-sealed → throws (no downgrade);
    /// keyless + plaintext → passes through (legacy/tests).
    public static func sealForWrite(_ plaintext: Data, url: URL,
                                    fileManager: FileManager = .default) throws -> Data {
        if let key = cachedKey { return try SealedFile.seal(plaintext, using: key) }
        if persistencePolicy == .encryptionRequired {
            throw SealError.keyUnavailable
        }
        if let existing = try? Data(contentsOf: url), SealedFile.isSealed(existing) {
            throw SealError.keyUnavailable
        }
        return plaintext
    }

    /// Opens bytes for a custom reader. Plaintext passes through keyless;
    /// sealed without a key throws (caller skips the row/file, never deletes).
    public static func openForRead(_ stored: Data) throws -> Data {
        guard SealedFile.isSealed(stored) else { return stored }
        guard let key = cachedKey else { throw SealError.keyUnavailable }
        return try SealedFile.open(stored, using: key)
    }

    /// Human-facing persistence error: key failures get an explicit message so
    /// a Keychain outage is never mistaken for a disk failure.
    public static func describe(_ error: Error, fallback: String) -> String {
        if let seal = error as? SealError, seal == .keyUnavailable {
            return "钥匙不可用，数据仅保留在内存中"
        }
        return fallback
    }
}
