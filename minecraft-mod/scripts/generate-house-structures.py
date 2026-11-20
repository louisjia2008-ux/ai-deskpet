#!/usr/bin/env python3
"""Regenerate the four bundled vanilla structure files and metadata."""
import gzip
import json
import struct
from pathlib import Path

DATA = Path(__file__).resolve().parents[1] / "src" / "main" / "resources" / "data" / "deskpet"
DATA_VERSION = 4440  # Minecraft 1.21.8


def integer(value):
    return struct.pack(">i", value)


def string(value):
    raw = value.encode("utf-8")
    return struct.pack(">H", len(raw)) + raw


def compound(entries):
    return b"".join(bytes([kind]) + string(name) + body for kind, name, body in entries) + b"\0"


def nbt_list(kind, entries):
    return bytes([kind]) + integer(len(entries)) + b"".join(entries)


def write_template(name, width, height, length, cells, *, entrance, door=None,
                   scaffold=(), phases=(), kind="house", floor_step_order="bottom_up"):
    states = sorted(set(cells.values()))
    palette = []
    for block, properties in states:
        entries = [(8, "Name", string("minecraft:" + block))]
        if properties:
            entries.append((10, "Properties", compound(
                [(8, key, string(value)) for key, value in properties]
            )))
        palette.append(compound(entries))
    blocks = [
        compound([
            (9, "pos", nbt_list(3, [integer(coordinate) for coordinate in pos])),
            (3, "state", integer(states.index(state))),
        ])
        for pos, state in sorted(cells.items(), key=lambda pair: (pair[0][1], pair[0][0], pair[0][2]))
    ]
    raw = b"\x0a\x00\x00" + compound([
        (3, "DataVersion", integer(DATA_VERSION)),
        (9, "size", nbt_list(3, [integer(width), integer(height), integer(length)])),
        (9, "palette", nbt_list(10, palette)),
        (9, "blocks", nbt_list(10, blocks)),
        (9, "entities", nbt_list(10, [])),
    ])
    (DATA / "structure" / (name + ".nbt")).write_bytes(gzip.compress(raw, mtime=0))
    (DATA / "house" / (name + ".json")).write_text(json.dumps({
        "version": 1,
        "kind": kind,
        "entrance": entrance,
        "door": door,
        "phases": phases,
        "scaffold": scaffold,
        "buildOrder": floor_step_order,
    }, indent=2) + "\n")


def add(cells, x, y, z, block, **properties):
    cells[x, y, z] = (block, tuple(sorted(properties.items())))


def door(cells, x, z):
    add(cells, x, 0, z, "oak_door", half="lower", facing="north")
    add(cells, x, 1, z, "oak_door", half="upper", facing="north")


def furnishings(cells, z):
    add(cells, 1, 0, z, "crafting_table")
    add(cells, 2, 0, z, "furnace", facing="north")
    add(cells, 4, 0, z, "chest", facing="north")
    add(cells, 5, 0, z, "torch")
    add(cells, 1, 0, 1, "torch")
    add(cells, 5, 0, 2, "red_bed", part="foot", facing="north")
    add(cells, 5, 0, 1, "red_bed", part="head", facing="north")


def starter():
    # Layout follows electron/minecraft-companion-runtime/core/blueprints/starterHouse.js.
    cells = {}
    for x in range(7):
        for z in range(7):
            if x in (0, 6) or z in (0, 6):
                if (x, z) != (3, 0):
                    for y in range(2):
                        add(cells, x, y, z, "cobblestone")
            add(cells, x, 2, z, "oak_planks")
    door(cells, 3, 0)
    furnishings(cells, 5)
    write_template("starter_house", 7, 4, 7, cells, entrance=(3, 0, -1), door=(3, 0, 0),
                   scaffold=((3, 0, 3),), phases=("walls", "scaffold", "roof", "furnish"),
                   floor_step_order="roof_outside_in")


def porch():
    cells = {}
    for x in range(1, 8):
        for z in range(2, 9):
            edge = x in (1, 7) or z in (2, 8)
            if edge and (x, z) != (4, 2):
                material = "oak_log" if x in (1, 7) and z in (2, 8) else "oak_planks"
                for y in range(3):
                    add(cells, x, y, z, material)
            add(cells, x, 3, z, "oak_slab", type="bottom")
    for x in range(1, 8):
        for z in range(2):
            add(cells, x, 3, z, "oak_slab", type="bottom")
            if x != 4:
                add(cells, x, 0, z, "oak_slab", type="bottom")
    for x in (1, 7):
        for y in (1, 2):
            add(cells, x, y, 0, "oak_log", axis="y")
    for x in (2, 6):
        for z in (2, 8):
            add(cells, x, 1, z, "glass")
    door(cells, 4, 2)
    add(cells, 2, 0, 6, "torch")
    add(cells, 6, 0, 6, "torch")
    add(cells, 3, 0, 7, "crafting_table")
    add(cells, 5, 0, 7, "furnace", facing="north")
    write_template("porch_cabin", 9, 5, 9, cells, entrance=(4, 0, -1), door=(4, 0, 2),
                   phases=("walls", "roof", "furnish"), floor_step_order="roof_outside_in")


def two_storey():
    cells = {}
    for x in range(9):
        for z in range(9):
            edge = x in (0, 8) or z in (0, 8)
            for y in range(7):
                if y == 6 or y == 3 and (x, z) not in ((7, 5), (7, 6), (7, 7)):
                    add(cells, x, y, z, "oak_planks")
                elif edge and not ((x, z) == (4, 0) and y < 2):
                    add(cells, x, y, z, "cobblestone" if y < 3 else "oak_planks")
    for y in (1, 4):
        for x, z in ((2, 0), (6, 0), (2, 8), (6, 8), (0, 4), (8, 4)):
            add(cells, x, y, z, "glass")
    for y in range(4):
        add(cells, 7, y, 7 - y, "oak_stairs", facing="north")
    door(cells, 4, 0)
    furnishings(cells, 7)
    add(cells, 2, 4, 2, "torch")
    add(cells, 6, 4, 6, "torch")
    write_template("two_storey_house", 9, 8, 9, cells, entrance=(4, 0, -1), door=(4, 0, 0),
                   phases=("walls", "floor", "roof", "furnish"), floor_step_order="roof_outside_in")


def wheat():
    cells = {}
    for x in range(9):
        for z in range(9):
            if (x, z) == (4, 4):
                add(cells, x, 0, z, "water", level="0")
            else:
                add(cells, x, 0, z, "farmland", moisture="0")
                add(cells, x, 1, z, "wheat", age="0")
    write_template("wheat_field", 9, 3, 9, cells, entrance=(4, 0, -1),
                   phases=("irrigate", "till", "sow"), kind="farm", floor_step_order="tile")


if __name__ == "__main__":
    starter()
    porch()
    two_storey()
    wheat()
