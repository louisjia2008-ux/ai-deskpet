// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "DeskPet",
    platforms: [.macOS(.v14)],
    targets: [
        // Pure, UI-free AI core shared by the app and the isolated LLM helper.
        .target(
            name: "AICore",
            path: "Sources/AICore"
        ),
        // PetBrain cognitive core (D1): pure Swift, no SwiftUI/AppKit/agent/persistence imports.
        .target(
            name: "PetBrainCore",
            dependencies: ["AICore"],
            path: "Sources/PetBrainCore"
        ),
        // Native agent runtime — fully independent of any external runtime (no OpenClaw/Hermes).
        .target(
            name: "PetAgentRuntime",
            dependencies: ["AICore", "PetBrainCore"],
            path: "Sources/PetAgentRuntime"
        ),
        // Isolated LLM process (fault domain, doc §11.2/§17.2). Talks JSON over stdio.
        .executableTarget(
            name: "DeskPetLLM",
            dependencies: ["AICore"],
            path: "Sources/DeskPetLLM"
        ),
        // Isolated, sandbox-style tool executor (doc 03 §4): token-gated, minimal-params, no DB/persona.
        .executableTarget(
            name: "DeskPetToolRunner",
            dependencies: ["AICore"],
            path: "Sources/DeskPetToolRunner"
        ),
        .executableTarget(
            name: "DeskPet",
            dependencies: ["AICore", "PetBrainCore", "PetAgentRuntime"],
            path: "Sources/DeskPet",
            swiftSettings: [
                // P22 — define DEBUG for every Debug build, plus PHASE_HARNESS so the
                // acceptance harnesses under Sources/DeskPet/Harness/ are compiled in
                // for local Debug runs and `swift test`. Release builds drop both
                // flags so the shipping binary doesn't carry the harness entry points.
                .define("DEBUG", .when(configuration: .debug)),
                .define("PHASE_HARNESS", .when(configuration: .debug)),
            ],
            linkerSettings: [.linkedLibrary("sqlite3")]   // system SQLite (P1→P2 storage; SQLCipher swaps in later)
        ),
        .testTarget(
            name: "DeskPetTests",
            dependencies: ["DeskPet", "AICore", "PetBrainCore", "PetAgentRuntime"],
            path: "Tests/DeskPetTests"
        ),
    ]
)
