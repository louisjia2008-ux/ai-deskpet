import Foundation

// P2 — pure, side-effect-free helpers shared by the isolated DeskPetToolRunner and the unit tests.
// Keeping the security-critical logic (path sandboxing, fetch target validation) here means it is
// testable in-process even though the runner itself is a separate executable.

/// Resolves a model-supplied relative path against a workspace root, refusing any escape. The runner
/// and the decision validator both rely on this so a tool can never touch a file outside the sandbox.
public enum WorkspacePathResolver {
    public enum ResolveError: Error, Equatable, CustomStringConvertible {
        case empty
        case absolutePath
        case tildeExpansion
        case parentTraversal
        case escapesRoot

        public var description: String {
            switch self {
            case .empty: return "empty path"
            case .absolutePath: return "absolute path not allowed"
            case .tildeExpansion: return "~ expansion not allowed"
            case .parentTraversal: return ".. traversal not allowed"
            case .escapesRoot: return "path escapes workspace root"
            }
        }
    }

    /// Lightweight reject used by the decision validator (no filesystem root needed). Mirrors the
    /// structural rules in `resolve` so an unsafe path is rejected before it ever reaches a tool.
    public static func isStructurallyUnsafe(_ raw: String) -> Bool {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return true }
        if trimmed.hasPrefix("/") { return true }
        if trimmed.hasPrefix("~") { return true }
        let components = trimmed.split(separator: "/", omittingEmptySubsequences: true)
        if components.contains("..") { return true }
        return false
    }

    /// Resolve `raw` (a relative path) inside `root`, returning an absolute URL guaranteed to stay
    /// within `root`. Throws on any structural violation or symlink/`..` escape.
    public static func resolve(_ raw: String, root: URL) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw ResolveError.empty }
        guard !trimmed.hasPrefix("/") else { throw ResolveError.absolutePath }
        guard !trimmed.hasPrefix("~") else { throw ResolveError.tildeExpansion }
        let components = trimmed.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !components.contains("..") else { throw ResolveError.parentTraversal }

        // Resolve symlinks on the root first so /tmp-style symlinked roots can't be escaped.
        let rootStd = root.resolvingSymlinksInPath().standardizedFileURL
        var url = rootStd
        for component in components { url.appendPathComponent(component) }
        let candidate = url.standardizedFileURL

        // Final containment check (defense in depth): candidate must be root itself or a descendant.
        let rootPath = rootStd.path.hasSuffix("/") ? rootStd.path : rootStd.path + "/"
        let candidatePath = candidate.path
        guard candidatePath == rootStd.path || candidatePath.hasPrefix(rootPath) else {
            throw ResolveError.escapesRoot
        }
        // Best-effort symlink check for already-existing paths: resolve the real path
        // (including intermediate symlinks) and re-verify containment. TOCTOU between
        // check and use remains — callers must still open with O_NOFOLLOW semantics
        // where available — but this closes the trivial workspace-symlink→/etc escape.
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: candidatePath, isDirectory: &isDir) {
            let real = URL(fileURLWithPath: candidatePath).resolvingSymlinksInPath().standardizedFileURL.path
            guard real == rootStd.path || real.hasPrefix(rootPath) else {
                throw ResolveError.escapesRoot
            }
            // Reject a final-component symlink outright: it is the classic escape vector
            // and legitimate workspace writes never need it.
            if let attrs = try? fm.attributesOfItem(atPath: candidatePath),
               attrs[.type] as? FileAttributeType == .typeSymbolicLink {
                throw ResolveError.escapesRoot
            }
        } else {
            // Parent may already exist as a symlink — resolve the deepest existing
            // ancestor and verify it stays inside the root.
            var ancestor = URL(fileURLWithPath: candidatePath).deletingLastPathComponent()
            while ancestor.path.hasPrefix(rootPath) || ancestor.path == rootStd.path {
                if fm.fileExists(atPath: ancestor.path) {
                    let realAncestor = ancestor.resolvingSymlinksInPath().standardizedFileURL.path
                    guard realAncestor == rootStd.path || realAncestor.hasPrefix(rootPath) else {
                        throw ResolveError.escapesRoot
                    }
                    break
                }
                let parent = ancestor.deletingLastPathComponent()
                if parent.path == ancestor.path { break }
                ancestor = parent
            }
        }
        return candidate
    }
}

/// Validates a network target before the runner fetches it: https-only, and no localhost/private/
/// link-local hosts (basic SSRF guard). Public so the decision validator can reject early too.
public enum FetchTargetValidator {
    public enum ValidationError: Error, Equatable, CustomStringConvertible {
        case malformed
        case schemeNotAllowed
        case missingHost
        case blockedHost

        public var description: String {
            switch self {
            case .malformed: return "malformed url"
            case .schemeNotAllowed: return "only https is allowed"
            case .missingHost: return "missing host"
            case .blockedHost: return "host is not allowed (localhost/private)"
            }
        }
    }

    public static func isAcceptable(_ raw: String) -> Bool {
        (try? validate(raw)) != nil
    }

    @discardableResult
    public static func validate(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else {
            throw ValidationError.malformed
        }
        guard scheme == "https" else { throw ValidationError.schemeNotAllowed }
        guard let host = url.host?.lowercased(), !host.isEmpty else { throw ValidationError.missingHost }
        guard !isBlockedHost(host) else { throw ValidationError.blockedHost }
        return url
    }

    static func isBlockedHost(_ host: String) -> Bool {
        let h = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if h == "localhost" || h.hasSuffix(".localhost") { return true }
        if h == "0.0.0.0" || h == "::" { return true }
        // Loopback / link-local / private IPv4 ranges (dotted form).
        if h.hasPrefix("127.") || h.hasPrefix("10.") || h.hasPrefix("169.254.") { return true }
        if h.hasPrefix("192.168.") { return true }
        if h.hasPrefix("172.") {
            let parts = h.split(separator: ".")
            if parts.count >= 2, let second = Int(parts[1]), (16...31).contains(second) { return true }
        }
        // IPv6 loopback / unique-local / link-local (with or without brackets).
        if h == "::1" { return true }
        if h.hasPrefix("fc") || h.hasPrefix("fd") || h.hasPrefix("fe80") { return true }
        // Non-dotted numeric encodings that URL.host keeps as-is: decimal
        // (2130706433 = 127.0.0.1), octal (0177.0.0.1), hex (0x7f.0.0.1).
        if isNumericLoopbackOrPrivate(h) { return true }
        return false
    }

    /// Catches 127.0.0.1 written as decimal/octal/hex integers, which `URL.host`
    /// does not normalize. Conservative: any single-integer host that decodes to
    /// loopback/private is blocked; unparseable numerics are left to the caller.
    static func isNumericLoopbackOrPrivate(_ host: String) -> Bool {
        let h = host.lowercased()
        // Single 32-bit integer (decimal or 0x-hex).
        if h.range(of: #"^(0x[0-9a-f]+|\d+)$"#, options: .regularExpression) != nil {
            let value: UInt32?
            if h.hasPrefix("0x") { value = UInt32(h.dropFirst(2), radix: 16) }
            else { value = UInt32(h, radix: 10) }
            if let v = value {
                let b0 = (v >> 24) & 0xFF, b1 = (v >> 16) & 0xFF
                if b0 == 127 { return true }                        // 2130706433 etc.
                if b0 == 10 { return true }                         // 10/8
                if b0 == 172, (16...31).contains(b1) { return true }// 172.16/12
                if b0 == 192, b1 == 168 { return true }             // 192.168/16
                if b0 == 169, b1 == 254 { return true }             // link-local
                if v == 0 { return true }                           // 0.0.0.0
            } else {
                return true // overflowed integer host — fail closed
            }
        }
        // Dotted quad with octal/hex parts: 0x7f.0.0.1, 0177.0.0.1
        if h.contains(".") {
            let parts = h.split(separator: ".")
            if parts.count == 4, parts.allSatisfy({ $0.range(of: #"^(0x[0-9a-f]+|0[0-7]*|\d+)$"#, options: .regularExpression) != nil }) {
                var bytes: [UInt32] = []
                for p in parts {
                    let s = String(p)
                    if s.hasPrefix("0x") { guard let v = UInt32(s.dropFirst(2), radix: 16) else { return true }; bytes.append(v) }
                    else if s.hasPrefix("0"), s.count > 1, s.range(of: #"^0[0-7]+$"#, options: .regularExpression) != nil {
                        guard let v = UInt32(s, radix: 8) else { return true }; bytes.append(v)
                    } else { guard let v = UInt32(s, radix: 10), v <= 255 else { return true }; bytes.append(v) }
                }
                if bytes.count == 4 {
                    if bytes[0] == 127 { return true }
                    if bytes[0] == 10 { return true }
                    if bytes[0] == 172, (16...31).contains(bytes[1]) { return true }
                    if bytes[0] == 192, bytes[1] == 168 { return true }
                    if bytes[0] == 169, bytes[1] == 254 { return true }
                }
            }
        }
        return false
    }

    /// Re-validate a redirect target before following it. The initial-URL check
    /// alone is insufficient because URLSession follows redirects by default.
    public static func validateRedirect(from: URL, to: URL) throws {
        guard to.scheme?.lowercased() == "https" else { throw ValidationError.schemeNotAllowed }
        guard let host = to.host?.lowercased(), !host.isEmpty else { throw ValidationError.missingHost }
        guard !isBlockedHost(host) else { throw ValidationError.blockedHost }
        _ = from
    }
}
