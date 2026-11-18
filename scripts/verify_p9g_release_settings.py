#!/usr/bin/env python3
import json
import plistlib
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read(relative):
    return (ROOT / relative).read_text(encoding="utf-8")


def fail(message, failures):
    failures.append(message)


def assert_contains(text, needle, label, failures):
    if needle not in text:
        fail(f"{label}: missing {needle}", failures)


def assert_not_contains(text, needle, label, failures):
    if needle in text:
        fail(f"{label}: unexpected {needle}", failures)


def debug_only_identifiers(text, identifiers):
    debug_depth = 0
    offenders = []
    for line_number, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if stripped == "#if DEBUG":
            debug_depth += 1
        elif stripped == "#endif":
            debug_depth = max(0, debug_depth - 1)
        if debug_depth == 0:
            for identifier in identifiers:
                if identifier in line:
                    offenders.append(f"{identifier}@{line_number}")
    return offenders


def main():
    failures = []
    project = read("project.yml")
    info = plistlib.loads((ROOT / "Resources/Info.plist").read_bytes())
    entitlements_path = ROOT / "Resources/Release.entitlements"

    assert_contains(project, "ENABLE_HARDENED_RUNTIME: YES", "project.yml", failures)
    assert_contains(project, "ENABLE_APP_SANDBOX: NO", "project.yml", failures)
    assert_contains(project, "CODE_SIGN_STYLE: Manual", "project.yml", failures)
    assert_contains(project, "CODE_SIGN_IDENTITY: Developer ID Application", "project.yml", failures)
    assert_contains(project, "CODE_SIGN_ENTITLEMENTS: Resources/Release.entitlements", "project.yml", failures)
    assert_contains(project, 'SWIFT_ACTIVE_COMPILATION_CONDITIONS: ""', "project.yml", failures)
    assert_not_contains(project, "DESKPET_P9F_REAL_HANDOFF_ACCEPTANCE", "project.yml", failures)
    assert_not_contains(project, "DESKPET_INTERNAL_HANDOFF_CONFORMANCE", "project.yml", failures)

    if not entitlements_path.exists():
        fail("Resources/Release.entitlements: missing", failures)
        entitlements = {}
    else:
        entitlements = plistlib.loads(entitlements_path.read_bytes())
        if not isinstance(entitlements, dict):
            fail("Resources/Release.entitlements: plist root is not a dictionary", failures)
            entitlements = {}

    denied_entitlements = [
        "com.apple.security.app-sandbox",
        "com.apple.security.get-task-allow",
        "com.apple.security.automation.apple-events",
        "com.apple.security.device.audio-input",
        "com.apple.security.device.camera",
        "com.apple.security.cs.allow-jit",
        "com.apple.security.cs.allow-unsigned-executable-memory",
        "com.apple.security.cs.disable-library-validation",
    ]
    for entitlement in denied_entitlements:
        if entitlement in entitlements:
            fail(f"Resources/Release.entitlements: unexpected {entitlement}", failures)

    unexpected = sorted(set(entitlements.keys()))
    if unexpected:
        fail(f"Resources/Release.entitlements: non-empty entitlement set {unexpected}", failures)

    if info.get("CFBundleIdentifier") != "com.deskpet.companion":
        fail("Info.plist: unexpected bundle identifier", failures)
    version = str(info.get("CFBundleShortVersionString", ""))
    build = str(info.get("CFBundleVersion", ""))
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        fail(f"Info.plist: marketing version is not semver-like: {version}", failures)
    if not re.fullmatch(r"[1-9]\d*", build):
        fail(f"Info.plist: build number is not a positive integer: {build}", failures)

    for relative in [
        "Sources/DeskPet/App/P9CLocalDiscoveryAppSmokeHarness.swift",
        "Sources/DeskPet/App/P9DLocalDiscoveryPresentationAppSmokeHarness.swift",
        "Sources/DeskPet/App/P9EPlaceHandoffAppSmokeHarness.swift",
        "Sources/DeskPet/App/P9FRealSystemHandoffAcceptanceHarness.swift",
    ]:
        text = read(relative).lstrip()
        if not text.startswith("#if DEBUG"):
            fail(f"{relative}: harness is not file-level DEBUG gated", failures)

    app_delegate = read("Sources/DeskPet/AppDelegate.swift")
    offenders = debug_only_identifiers(
        app_delegate,
        [
            "P9CLocalDiscoveryAppSmokeHarness",
            "P9DLocalDiscoveryPresentationAppSmokeHarness",
            "P9EPlaceHandoffAppSmokeHarness",
            "P9FRealSystemHandoffAcceptanceHarness",
        ],
    )
    if offenders:
        fail(f"AppDelegate.swift: harness references outside DEBUG: {', '.join(offenders)}", failures)

    release_policy = read("Sources/PetAgentRuntime/LocalDiscovery/PlaceHandoffReleaseSupport.swift")
    assert_contains(release_policy, "return .releaseDistribution", "PlaceHandoffReleaseSupport.swift", failures)
    assert_contains(release_policy, "humanVisibleHandlerConformanceNotCompleted", "PlaceHandoffReleaseSupport.swift", failures)

    result = {
        "verifier": "P9G_RELEASE_SETTINGS_VERIFIER",
        "status": "PASS" if not failures else "FAIL",
        "distributionLane": "DIRECT_DEVELOPER_ID_DISTRIBUTION",
        "hardenedRuntimeExpected": True,
        "appSandboxExpected": False,
        "releaseEntitlementCount": len(entitlements),
        "failures": failures,
    }
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
