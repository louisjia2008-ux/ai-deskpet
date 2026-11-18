#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


REQUIRED_TRACKABLE = [
    ".gitignore",
    "project.yml",
    "Assets/LumiScholar/source/pet.json",
    "Assets/LumiScholar/source/spritesheet.webp",
    "Assets/LumiScholar/approved/lumi_scholar_manifest.json",
    "Assets/LumiScholar/approved/clips/lumi_scholar_manifest.json",
    "Assets/LumiScholar/approved/clips/idle/frame_000.png",
    "scripts/import_codex_pet.py",
    "scripts/validate_lumi_scholar_assets.py",
    "scripts/verify_lumi_repository_persistence.py",
    "docs/character_animation/LUMI_SCHOLAR_REPOSITORY_PERSISTENCE.md",
    "Tests/DeskPetTests/LumiScholarRuntimeTests.swift",
    "Sources/DeskPet/AppDelegate.swift",
    "Sources/DeskPet/Window/OverlayWindowController.swift",
    "Sources/DeskPet/Render/CharacterAnimationTypes.swift",
    "Sources/DeskPet/Render/CharacterAnimationStateMachine.swift",
    "Sources/DeskPet/Render/CharacterVisualSystemLoader.swift",
    "Sources/DeskPet/Render/StaticPNGCharacterRenderer.swift",
    "Sources/DeskPet/Render/StaticSpritePresentationDriver.swift",
    "Sources/PetAgentRuntime/CharacterPresentationDriver.swift",
    "Sources/PetAgentRuntime/CharacterBehaviorStateMachine.swift",
]

INTENTIONALLY_IGNORED = [
    "DeskPet.xcodeproj",
    "Assets/LumiScholar/qa/import_report.json",
    "Assets/LumiScholar/review/lumi_scholar_runtime_review/idle.gif",
    "Assets/LumiScholar/review/lumi_scholar_runtime_review/00_idle_start.png",
]


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None, timeout: int | None = None) -> dict[str, Any]:
    started = time.time()
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
    )
    return {
        "command": cmd,
        "cwd": str(cwd),
        "exit_code": proc.returncode,
        "duration_seconds": round(time.time() - started, 3),
        "output": proc.stdout,
        "passed": proc.returncode == 0,
    }


def git_root(deskpet_root: Path) -> Path:
    result = run(["git", "rev-parse", "--show-toplevel"], cwd=deskpet_root)
    if result["exit_code"] != 0:
        raise RuntimeError(result["output"])
    return Path(result["output"].strip())


def rel_to_repo(repo_root: Path, deskpet_root: Path, rel: str) -> str:
    return str((deskpet_root / rel).relative_to(repo_root))


def parse_check_ignore(output: str) -> dict[str, Any]:
    line = output.strip().splitlines()[-1] if output.strip() else ""
    if not line:
        return {"matched": False, "negated": False, "rule": None}
    rule_part = line.split("\t", 1)[0]
    pattern = rule_part.rsplit(":", 1)[-1]
    return {"matched": True, "negated": pattern.startswith("!"), "rule": rule_part}


def check_ignore(deskpet_root: Path, paths: list[str]) -> dict[str, Any]:
    entries = {}
    for rel in paths:
        proc = subprocess.run(
            ["git", "check-ignore", "-v", rel],
            cwd=deskpet_root,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        parsed = parse_check_ignore(proc.stdout)
        parsed["path"] = rel
        parsed["exit_code"] = proc.returncode
        parsed["output"] = proc.stdout.strip()
        entries[rel] = parsed
    return entries


def copy_git_discoverable(repo_root: Path, deskpet_root: Path) -> dict[str, Any]:
    prefix = str(deskpet_root.relative_to(repo_root))
    tmp_root = Path(tempfile.mkdtemp(prefix="deskpet-lumi-persistence.", dir="/private/tmp"))
    raw = subprocess.check_output(
        [
            "git",
            "-c",
            "core.quotePath=false",
            "ls-files",
            "-z",
            "--cached",
            "--modified",
            "--others",
            "--exclude-standard",
            "--",
            prefix,
        ],
        cwd=repo_root,
    )
    paths: list[str] = []
    seen: set[str] = set()
    for item in raw.split(b"\0"):
        if not item:
            continue
        rel = item.decode("utf-8")
        if rel in seen:
            continue
        seen.add(rel)
        src = repo_root / rel
        if not src.is_file() and not src.is_symlink():
            continue
        dst = tmp_root / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            dst.symlink_to(src.readlink())
        else:
            shutil.copy2(src, dst)
        paths.append(rel)
    (tmp_root / "filelist.txt").write_text("\n".join(paths) + "\n", encoding="utf-8")
    return {
        "temp_root": str(tmp_root),
        "deskpet_root": str(tmp_root / prefix),
        "file_count": len(paths),
        "filelist": str(tmp_root / "filelist.txt"),
        "contains": {
            rel: rel_to_repo(repo_root, deskpet_root, rel) in paths
            for rel in REQUIRED_TRACKABLE + INTENTIONALLY_IGNORED
        },
    }


def launch_and_probe(app_executable: Path, workdir: Path, timeout_seconds: float = 10.0) -> dict[str, Any]:
    log_path = Path(tempfile.mkdtemp(prefix="deskpet-lumi-launch.", dir="/private/tmp")) / "startup.log"
    with log_path.open("w", encoding="utf-8") as log:
        proc = subprocess.Popen([str(app_executable)], cwd=workdir, stdout=log, stderr=subprocess.STDOUT, text=True)
    found = False
    idle_found = False
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        if log_path.exists():
            text = log_path.read_text(encoding="utf-8", errors="replace")
            found = "Loaded Lumi Scholar manifest" in text
            idle_found = "Loaded character clip idle" in text
            if found and idle_found:
                break
        time.sleep(0.25)
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)
    return {
        "log": str(log_path),
        "loaded_lumi_manifest": found,
        "loaded_idle_clip": idle_found,
        "passed": found and idle_found,
        "output_excerpt": log_path.read_text(encoding="utf-8", errors="replace")[-4000:] if log_path.exists() else "",
    }


def clean_recovery(report: dict[str, Any], args: argparse.Namespace, repo_root: Path, deskpet_root: Path) -> None:
    copied = copy_git_discoverable(repo_root, deskpet_root)
    report["clean_recovery"] = {"copy": copied, "steps": []}
    clean_root = Path(copied["deskpet_root"])

    report["clean_recovery"]["steps"].append(run(["xcodegen", "generate"], cwd=clean_root, timeout=120))
    report["clean_recovery"]["steps"].append(run(["python3", "scripts/import_codex_pet.py"], cwd=clean_root, timeout=120))
    report["clean_recovery"]["steps"].append(run(
        [
            "python3",
            "scripts/validate_lumi_scholar_assets.py",
            "--output",
            "Assets/LumiScholar/qa/repository_persistence_validation_report.json",
        ],
        cwd=clean_root,
        timeout=120,
    ))

    if args.clean_build:
        derived = Path(tempfile.mkdtemp(prefix="deskpet-lumi-derived.", dir="/private/tmp"))
        env = os.environ.copy()
        env["CLANG_MODULE_CACHE_PATH"] = str(Path(tempfile.mkdtemp(prefix="deskpet-lumi-clang.", dir="/private/tmp")))
        build = run(
            [
                "xcodebuild",
                "-project",
                "DeskPet.xcodeproj",
                "-scheme",
                "DeskPet",
                "-configuration",
                "Debug",
                "-derivedDataPath",
                str(derived),
                "-destination",
                "platform=macOS",
                "CODE_SIGNING_ALLOWED=NO",
                "-quiet",
                "build",
            ],
            cwd=clean_root,
            env=env,
            timeout=240,
        )
        report["clean_recovery"]["steps"].append(build)
        bundle_root = derived / "Build/Products/Debug/DeskPet.app/Contents/Resources"
        report["clean_recovery"]["steps"].append(run(
            [
                "python3",
                "scripts/validate_lumi_scholar_assets.py",
                "--bundle-root",
                str(bundle_root),
                "--output",
                "Assets/LumiScholar/qa/repository_persistence_bundle_validation_report.json",
            ],
            cwd=clean_root,
            timeout=120,
        ))
        report["clean_recovery"]["derived_data"] = str(derived)
        report["clean_recovery"]["debug_app"] = str(derived / "Build/Products/Debug/DeskPet.app")

        if args.launch:
            app_exec = derived / "Build/Products/Debug/DeskPet.app/Contents/MacOS/DeskPet"
            report["clean_recovery"]["launch_probe"] = launch_and_probe(app_exec, clean_root)


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Lumi Scholar repository persistence without staging or committing.")
    parser.add_argument("--clean-build", action="store_true", help="Build the clean temporary copy with xcodebuild Debug.")
    parser.add_argument("--launch", action="store_true", help="Launch the clean Debug app and probe startup logs for Lumi.")
    parser.add_argument("--output", default=Path("Assets/LumiScholar/qa/repository_persistence_verification.json"), type=Path)
    args = parser.parse_args()

    deskpet_root = Path(__file__).resolve().parents[1]
    repo_root = git_root(deskpet_root)
    required_ignore = check_ignore(deskpet_root, REQUIRED_TRACKABLE)
    ignored_ignore = check_ignore(deskpet_root, INTENTIONALLY_IGNORED)

    required_passed = {
        rel: (not info["matched"]) or info["negated"]
        for rel, info in required_ignore.items()
    }
    ignored_passed = {
        rel: info["matched"] and not info["negated"]
        for rel, info in ignored_ignore.items()
    }

    report: dict[str, Any] = {
        "status": "PASSED",
        "repo_root": str(repo_root),
        "deskpet_root": str(deskpet_root),
        "required_trackable": required_ignore,
        "intentionally_ignored": ignored_ignore,
        "required_trackable_passed": required_passed,
        "intentionally_ignored_passed": ignored_passed,
    }
    clean_recovery(report, args, repo_root, deskpet_root)

    failures: list[str] = []
    failures.extend(rel for rel, passed in required_passed.items() if not passed)
    failures.extend(rel for rel, passed in ignored_passed.items() if not passed)
    copy_contains = report["clean_recovery"]["copy"]["contains"]
    for rel in REQUIRED_TRACKABLE:
        if not copy_contains.get(rel):
            failures.append(f"clean copy missing required trackable file: {rel}")
    for rel in INTENTIONALLY_IGNORED:
        if copy_contains.get(rel):
            failures.append(f"clean copy unexpectedly contains ignored file: {rel}")
    for step in report["clean_recovery"].get("steps", []):
        if not step["passed"]:
            failures.append("command failed: " + " ".join(step["command"]))
    launch_probe = report["clean_recovery"].get("launch_probe")
    if args.launch and not launch_probe:
        failures.append("launch probe did not run")
    if launch_probe and not launch_probe["passed"]:
        failures.append("launch probe did not observe Lumi startup")

    report["failures"] = failures
    report["status"] = "PASSED" if not failures else "FAILED"

    output = args.output if args.output.is_absolute() else deskpet_root / args.output
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": report["status"],
        "report": str(output),
        "failure_count": len(failures),
        "clean_root": report["clean_recovery"]["copy"]["deskpet_root"],
        "debug_app": report["clean_recovery"].get("debug_app"),
    }, ensure_ascii=False, indent=2))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
