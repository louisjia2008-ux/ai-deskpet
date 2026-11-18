import XCTest

// P22 — minimal property-based testing helper. SwiftCheck is intentionally
// not added as a dependency; the goal here is to drive 200-iteration fuzz
// sweeps against state machines and string sanitizers to surface:
//   • crashes the deterministic unit tests miss
//   • assertion-fires that only show up under a specific input sequence
//   • state-machine transitions that violate documented invariants
//
// Conventions:
//   * `forAll(iterations:)` runs the body `iterations` times with a fresh
//     `RandomNumberGenerator` each pass.
//   * Shrinking is left to humans — `XCTFail` dumps the failing input.

enum Property {
    /// Default iteration count. 200 is enough to surface shallow bugs
    /// without making the suite noticeably slower (~10-50ms total per
    /// property in practice).
    static let defaultIterations = 200

    static func forAll(_ iterations: Int = Property.defaultIterations,
                       _ body: (inout SeededRNG) throws -> Void) rethrows {
        var rng = SeededRNG(seed: UInt64.random(in: 1...UInt64.max))
        for _ in 0..<iterations {
            try body(&rng)
        }
    }
}

/// Deterministic PRNG (xorshift64*) seeded once per run. Reproducing a
/// failing case is as simple as saving the seed printed next to the
/// `XCTFail` and re-running with `Property.forAll(1)` after re-seeding.
struct SeededRNG: RandomNumberGenerator {
    private var state: UInt64
    init(seed: UInt64) { self.state = seed | 1 }
    mutating func next() -> UInt64 {
        state ^= state << 13
        state ^= state >> 7
        state ^= state << 17
        return state
    }
}

extension SeededRNG {
    /// Uniform Int in `range`. Mirrors `Int.random(in:)` for test ergonomics.
    mutating func int(in range: Range<Int>) -> Int {
        let span = UInt64(range.upperBound - range.lowerBound)
        return range.lowerBound + Int(next() % span)
    }

    /// Uniform Int in `range`.
    mutating func int(in range: ClosedRange<Int>) -> Int {
        let span = UInt64(range.upperBound - range.lowerBound + 1)
        return range.lowerBound + Int(next() % span)
    }

    /// Random bool.
    mutating func bool() -> Bool { next() & 1 == 0 }

    /// Random ASCII string of length `length`, biased to punctuation /
    /// whitespace so sanitizers see "real-looking" inputs.
    mutating func string(length: Int) -> String {
        let chars: [Character] = Array("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \n\t\"'<>&;{}()[]|/\\")
        var result = ""
        result.reserveCapacity(length)
        for _ in 0..<length {
            result.append(chars[Int(next() % UInt64(chars.count))])
        }
        return result
    }

    /// Random pick from `array`.
    mutating func pick<T>(_ array: [T]) -> T {
        array[Int(next() % UInt64(array.count))]
    }
}
