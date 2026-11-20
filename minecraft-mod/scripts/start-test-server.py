#!/usr/bin/env python3
"""Start a pinned, loopback-only Fabric acceptance server using the Homebrew JDK."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import fcntl
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import zipfile

MOD = Path(__file__).resolve().parents[1]
JAVA_HOME = Path("/opt/homebrew/opt/openjdk@21")
MOD_JAR = "deskpet-0.1.0.jar"


def checksum(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def install_artifact(directory, artifact):
    target = directory / artifact["path"]
    expected = artifact["sha256"]
    if target.is_file() and checksum(target) == expected:
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=target.parent, delete=False) as file:
        staged = Path(file.name)
    try:
        subprocess.run(
            ["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3",
             "--max-time", "120", "--output", str(staged), artifact["url"]],
            check=True,
        )
        if checksum(staged) != expected:
            raise RuntimeError(f"SHA-256 mismatch for {artifact['path']}")
        staged.replace(target)
    finally:
        staged.unlink(missing_ok=True)


def properties(directory, port, rcon_port):
    target = directory / "server.properties"
    settings = {}
    if target.exists():
        for line in target.read_text().splitlines():
            if line and not line.startswith(("#", "!")) and "=" in line:
                key, value = line.split("=", 1)
                settings[key] = value
    settings.update({
        "server-ip": "127.0.0.1",
        "server-port": str(port),
        "online-mode": "false",
        "enforce-secure-profile": "false",
        "enable-rcon": "true",
        "enable-query": "false",
        "enable-jmx-monitoring": "false",
        "rcon.port": str(rcon_port),
        "rcon.password": secrets.token_hex(24),
        "broadcast-rcon-to-ops": "false",
        "level-name": "world",
        "pause-when-empty-seconds": "0",
        "spawn-protection": "0",
    })
    tmp = target.with_suffix(".tmp")
    tmp.write_text("".join(f"{key}={value}\n" for key, value in sorted(settings.items())))
    tmp.chmod(0o600)
    tmp.replace(target)


def start(args):
    default = "run-server-raw" if args.control else "run-server"
    workdir = Path(os.environ.get("DESKPET_TEST_SERVER_DIR", MOD / default)).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    lock = workdir / ".deskpet-test-server.lock"
    marker = workdir / ".deskpet-test-server"
    if not marker.exists() and any(workdir.iterdir()):
        raise RuntimeError("A new test server requires an empty directory")
    with lock.open("a") as handle:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        variant = "raw\n" if args.control else "polymer\n"
        if marker.exists() and marker.read_text() != variant:
            raise RuntimeError("Use a separate world directory for the raw control")
        marker.write_text(variant)
        eula = workdir / "eula.txt"
        if args.accept_eula:
            eula.write_text("eula=true\n")
        if not eula.exists() or "eula=true" not in eula.read_text().splitlines():
            raise RuntimeError("Accept the Minecraft EULA before starting this test server (--accept-eula)")

        source = args.jar.resolve()
        with zipfile.ZipFile(source) as candidate:
            raw = "deskpet-raw-survey-wand" in candidate.namelist()
        if raw != args.control:
            raise RuntimeError("The selected mod JAR does not match the requested test variant")

        artifacts = json.loads((MOD / "scripts/server-artifacts.json").read_text())
        with ThreadPoolExecutor(max_workers=6) as pool:
            list(pool.map(lambda item: install_artifact(workdir, item), artifacts))
        allowed_mods = {Path(item["path"]).name for item in artifacts if item["path"].startswith("mods/")}
        allowed_mods.add(MOD_JAR)
        unexpected = [path.name for path in (workdir / "mods").iterdir() if path.name not in allowed_mods]
        if unexpected:
            raise RuntimeError("Unexpected files in the test mods directory: " + ", ".join(sorted(unexpected)))
        shutil.copyfile(source, workdir / "mods" / MOD_JAR)
        print(f"DeskPet mod SHA-256 {checksum(workdir / 'mods' / MOD_JAR)}", flush=True)

        port = int(os.environ.get("DESKPET_TEST_SERVER_PORT", "25583" if args.control else "25581"))
        rcon_port = int(os.environ.get("DESKPET_TEST_RCON_PORT", "25584" if args.control else "25582"))
        if not 1024 <= port <= 65535 or not 1024 <= rcon_port <= 65535 or port == rcon_port:
            raise RuntimeError("Use two distinct non-privileged test ports")
        properties(workdir, port, rcon_port)
        env = dict(os.environ, JAVA_HOME=str(JAVA_HOME))
        command = [str(JAVA_HOME / "bin/java"), "-Xmx3G", "-Dfabric.gameJarPath=server.jar",
                   "-cp", "fabric-libraries/*", "net.fabricmc.loader.impl.launch.knot.KnotServer", "nogui"]
        return subprocess.call(command, cwd=workdir, env=env)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--accept-eula", action="store_true", help="record explicit Minecraft EULA acceptance")
    parser.add_argument("--control", action="store_true", help="use the isolated non-Polymer test control")
    parser.add_argument("--jar", type=Path, default=MOD / "build/libs" / MOD_JAR)
    arguments = parser.parse_args()
    try:
        raise SystemExit(start(arguments))
    except (OSError, RuntimeError, subprocess.CalledProcessError, ValueError, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")
