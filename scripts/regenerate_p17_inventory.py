#!/usr/bin/env python3
"""P17 / R2-06 / R2-10 / R4-02 — regenerate the numeric evidence in AFTER_INVENTORY.md and
IMPLEMENTATION_NOTES.md from the ACTUAL PNGs on disk. Run from the review dir:

    python3 scripts/regenerate_p17_inventory.py
    python3 scripts/regenerate_p17_inventory.py /path/to/review-root
    python3 scripts/regenerate_p17_inventory.py /path/to/review-root --harness v4

The script is read-only: it writes a single Markdown block to stdout containing the
measured byte + unique-color counts per file, the cross-appearance guard verdicts, and
the MD5 of the flagship floatingChatExpanded pair. Paste the block into
07_after_screenshots/AFTER_INVENTORY.md (replacing the numeric table) and the unique-color
section of 04_implementation/IMPLEMENTATION_NOTES.md.

The point of having a script that you can re-run after any capture is to make the
"fabricated precision numbers" failure mode from R1-01 / R1-17 / R2-10 mechanically
impossible — the script's output IS the truth source, so the report can never again
disagree with the files.

P17 / R4-02 — the R2-10 revision hardcoded every path to `p17_harness_v2`, so once the
harness moved to v3 (R3) and v4 (R4) the regeneration script measured the superseded
v2 set and the inventory diverged from the actual evidence. The R4-02 fix scans for the
newest `p17_harness_vN` directory under `07_after_screenshots/` and inventories it by
default; callers may override via `--harness <name>`. The legacy `p17_harness_v2` path
is still measured when explicitly requested (e.g. `--harness p17_harness_v2`) so old
diff reproducibility is preserved.
"""
import argparse
import hashlib
import os
import re
import struct
import sys
import zlib


def png_unique_colors(path):
    data = open(path, "rb").read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} is not a PNG")
    i = 8
    w = h = 0
    idat = b""
    while i < len(data):
        ln = struct.unpack(">I", data[i:i+4])[0]
        tp = data[i+4:i+8]
        pl = data[i+8:i+8+ln]
        if tp == b"IHDR":
            w, h = struct.unpack(">II", pl[:8])
        elif tp == b"IDAT":
            idat += pl
        elif tp == b"IEND":
            break
        i += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * 4 + 1
    colors = set()
    opaque = 0
    for y in range(h):
        off = y * stride + 1
        for x in range(w):
            r = raw[off + x*4]; g = raw[off + x*4 + 1]; b = raw[off + x*4 + 2]; a = raw[off + x*4 + 3]
            colors.add((r, g, b, a))
            if a > 10:
                opaque += 1
    return len(colors), opaque, w, h


def md5(path):
    h = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def collect(root):
    by_name = {}
    for fn in sorted(os.listdir(root)):
        if not fn.endswith(".png"):
            continue
        path = os.path.join(root, fn)
        uniq, opaque, w, h = png_unique_colors(path)
        by_name[fn] = {
            "path": path,
            "bytes": os.path.getsize(path),
            "uniq": uniq,
            "opaque": opaque,
            "size": f"{w}x{h}",
            "md5": md5(path),
        }
    return by_name


def newest_harness(review_root):
    """P17 / R4-02 — find the newest `p17_harness_vN` directory under
    `07_after_screenshots/`. Falls back to `p17_harness` if no versioned set exists.
    Returns (label, sub) or None.
    """
    candidates_root = os.path.join(review_root, "07_after_screenshots")
    if not os.path.isdir(candidates_root):
        return None
    versioned = []
    legacy = None
    for entry in sorted(os.listdir(candidates_root)):
        if not entry.startswith("p17_harness"):
            continue
        full = os.path.join(candidates_root, entry)
        if not os.path.isdir(full):
            continue
        m = re.match(r"^p17_harness_v(\d+)$", entry)
        if m:
            versioned.append((int(m.group(1)), entry, full))
        elif entry == "p17_harness":
            legacy = (0, entry, full)
    if versioned:
        versioned.sort()
        _, name, _ = versioned[-1]
        return (name, f"07_after_screenshots/{name}/screenshots")
    if legacy:
        _, name, _ = legacy
        return (name, f"07_after_screenshots/{name}/screenshots")
    return None


def newest_onboarding(review_root):
    """P17 / R4-02 — find the newest `p17_onboarding_harness[_vN]` directory.
    Returns (label, sub) or None.
    """
    candidates_root = os.path.join(review_root, "07_after_screenshots")
    if not os.path.isdir(candidates_root):
        return None
    versioned = []
    legacy = None
    for entry in sorted(os.listdir(candidates_root)):
        if not entry.startswith("p17_onboarding_harness"):
            continue
        full = os.path.join(candidates_root, entry)
        if not os.path.isdir(full):
            continue
        m = re.match(r"^p17_onboarding_harness_v(\d+)$", entry)
        if m:
            versioned.append((int(m.group(1)), entry, full))
        elif entry == "p17_onboarding_harness":
            legacy = (0, entry, full)
    if versioned:
        versioned.sort()
        _, name, _ = versioned[-1]
        return (name, f"07_after_screenshots/{name}")
    if legacy:
        _, name, _ = legacy
        return (name, f"07_after_screenshots/{name}")
    return None


def main():
    parser = argparse.ArgumentParser(description="Regenerate P17 inventory numbers from disk.")
    parser.add_argument("review_root", nargs="?", default=os.getcwd(),
                        help="Path to the review directory (default: cwd)")
    parser.add_argument("--harness", default=None,
                        help="Explicit harness dir name (e.g. p17_harness_v4). Defaults to the newest p17_harness_vN under 07_after_screenshots/.")
    parser.add_argument("--onboarding", default=None,
                        help="Explicit onboarding dir name (e.g. p17_onboarding_harness_v3). Defaults to the newest p17_onboarding_harness_vN.")
    parser.add_argument("--include-legacy-v2", action="store_true",
                        help="Also inventory the superseded p17_harness_v2 directory (R2-10 reproducibility).")
    args = parser.parse_args()
    review_root = os.path.abspath(args.review_root)

    # P17 / R4-02 — discover the harness + onboarding directories. Default to the
    # newest versioned set so the script always agrees with the delivered evidence.
    sections = []

    harness = args.harness
    if harness:
        harness_sub = f"07_after_screenshots/{harness}/screenshots"
    else:
        auto = newest_harness(review_root)
        if auto:
            harness, harness_sub = auto
        else:
            harness, harness_sub = None, None

    if harness and harness_sub:
        harness_root = os.path.join(review_root, harness_sub)
        if os.path.isdir(harness_root):
            sections.append((harness, harness_sub, collect(harness_root)))

    if args.include_legacy_v2:
        legacy_sub = "07_after_screenshots/p17_harness_v2/screenshots"
        legacy_root = os.path.join(review_root, legacy_sub)
        if os.path.isdir(legacy_root):
            sections.append(("p17_harness_v2 (legacy)", legacy_sub, collect(legacy_root)))

    p16_sub = "07_after_screenshots/p16_harness_v2/screenshots"
    p16_root = os.path.join(review_root, p16_sub)
    if os.path.isdir(p16_root):
        sections.append(("p16_harness_v2/screenshots", p16_sub, collect(p16_root)))

    onboarding = args.onboarding
    if onboarding:
        onboarding_sub = f"07_after_screenshots/{onboarding}"
    else:
        auto = newest_onboarding(review_root)
        if auto:
            onboarding, onboarding_sub = auto
        else:
            onboarding, onboarding_sub = None, None

    if onboarding and onboarding_sub:
        onboarding_root = os.path.join(review_root, onboarding_sub)
        if os.path.isdir(onboarding_root):
            sections.append((onboarding, onboarding_sub, collect(onboarding_root)))

    out = []
    out.append("# P17 INVENTORY — measured counts (auto-generated)")
    out.append("")
    out.append(f"> P17 / R4-02 — harness dir = `{harness or 'NONE FOUND'}`, onboarding dir = `{onboarding or 'NONE FOUND'}`.")
    out.append("> Paste this block into AFTER_INVENTORY.md / IMPLEMENTATION_NOTES.md.")
    out.append("> The numbers come directly from the PNGs; the script is re-runnable, so the")
    out.append("> report can never disagree with the files again.")
    out.append("")
    for label, sub, info in sections:
        out.append(f"## `{sub}/`  ({len(info)} files)")
        out.append("")
        out.append("| File | Size | Bytes | Unique colors | MD5 |")
        out.append("| --- | --- | ---: | ---: | --- |")
        for fn, m in info.items():
            out.append(f"| `{fn}` | {m['size']} | {m['bytes']:,} | {m['uniq']:,} | `{m['md5']}` |")
        out.append("")

    # Cross-appearance guard summary — read summary.json from the harness dir if present
    if harness:
        summary_path = os.path.join(review_root, f"07_after_screenshots/{harness}/summary.json")
        if os.path.isfile(summary_path):
            import json
            try:
                data = json.load(open(summary_path))
                guards = {k: v for k, v in data.get("captures", {}).items() if "appearanceGuard" in k}
                if guards:
                    out.append(f"## Cross-appearance guard verdicts (`{harness}/summary.json`)")
                    out.append("")
                    out.append("| Surface | ok | identical fraction | mean luminance (light → dark) | dark-accent px | light-accent px |")
                    out.append("| --- | :---: | ---: | :--- | ---: | ---: |")
                    for k in sorted(guards):
                        g = guards[k]
                        ok_str = '✓' if g.get('ok') else '✗'
                        if g.get('exempt'):
                            ok_str = '✓ (exempt)'
                        # R5-05 — exempt rows don't carry meanLuminance / accent counts
                        # (the SpriteKit sprite is content-identical between light/dark
                        # by construction; the harness records `exempt: true` with
                        # `identicalFraction=0` and no other measurements). Emit "—" for
                        # missing keys so the pasted block is verbatim-reproducible from
                        # the script (the previous "0.000 → 0.000" defaults were hand-
                        # adjusted in the delivered inventory).
                        def _fmt_float(key, default=0.0):
                            if key in g:
                                return f"{float(g[key]):.4f}" if key == 'identicalFraction' else f"{float(g[key]):.3f}"
                            return "—"
                        def _fmt_int(key):
                            return f"{int(g[key]):,}" if key in g else "—"
                        out.append(
                            f"| `{k.replace('_appearanceGuard','')}` | "
                            f"{ok_str} | "
                            f"{_fmt_float('identicalFraction')} | "
                            f"{_fmt_float('meanLuminanceLight')} → {_fmt_float('meanLuminanceDark')} | "
                            f"{_fmt_int('darkAccentPixelCount')} | "
                            f"{_fmt_int('lightAccentPixelCount')} |"
                        )
                    out.append("")
            except Exception as e:
                out.append(f"> summary.json parse error: {e}")
                out.append("")

    # Flagship floatingChatExpanded sanity
    if harness:
        fc_light = os.path.join(review_root, f"07_after_screenshots/{harness}/screenshots/p17_floatingChatExpanded_light.png")
        fc_dark  = os.path.join(review_root, f"07_after_screenshots/{harness}/screenshots/p17_floatingChatExpanded_dark.png")
        if os.path.isfile(fc_light) and os.path.isfile(fc_dark):
            out.append("## Flagship floatingChatExpanded (LD-01 evidence)")
            out.append("")
            out.append(f"- `p17_floatingChatExpanded_light.png` — {os.path.getsize(fc_light):,} bytes, MD5 `{md5(fc_light)}`")
            out.append(f"- `p17_floatingChatExpanded_dark.png`  — {os.path.getsize(fc_dark):,} bytes, MD5 `{md5(fc_dark)}`")
            out.append(f"- MD5 differ: **{md5(fc_light) != md5(fc_dark)}**")
            out.append("")
    print("\n".join(out))


if __name__ == "__main__":
    main()