#!/usr/bin/env python3
"""Create a bounded model-only ZIP for local DeskPet use; never changes the input archive.
No asset redistribution permission is implied. The original license remains authoritative.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile


def import_model(source: Path, destination: Path):
    if source.stat().st_size > 1024 * 1024 * 1024:
        raise ValueError('Source exceeds 1 GiB import limit')
    if destination.exists():
        raise ValueError('Destination already exists; choose a new output path')
    with zipfile.ZipFile(source) as archive:
        entries = archive.infolist()
        if len(entries) > 4096 or sum(e.file_size for e in entries) > 1024 * 1024 * 1024:
            raise ValueError('Archive exceeds import limits')
        eligible = []
        for entry in entries:
            name = PurePosixPath(entry.filename.replace('\\', '/'))
            if name.is_absolute() or '..' in name.parts:
                raise ValueError('Unsafe archive path')
            if any(p == '__MACOSX' or p.startswith('._') for p in name.parts):
                continue
            if not entry.is_dir():
                eligible.append((entry, name))
        settings = [(e,n) for e,n in eligible if str(n).lower().endswith('.model3.json')]
        if len(settings) != 1:
            raise ValueError('Expected exactly one model3.json')
        base = settings[0][1].parent
        selected = [(e,n.relative_to(base)) for e,n in eligible
                    if n.is_relative_to(base) and n.suffix.lower() in {'.json','.moc3','.png','.jpg','.jpeg'}
                    and not str(n).endswith('.vtube.json')]
        if sum(e.file_size for e,_ in selected) > 256 * 1024 * 1024:
            raise ValueError('Selected model exceeds runtime expansion limit')
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            with zipfile.ZipFile(destination, 'x', zipfile.ZIP_DEFLATED) as output:
                for entry, name in sorted(selected, key=lambda pair: str(pair[1])):
                    info = zipfile.ZipInfo(str(name), date_time=(2020,1,1,0,0,0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    output.writestr(info, archive.read(entry))
            if destination.stat().st_size > 128 * 1024 * 1024:
                raise ValueError('Model-only ZIP exceeds runtime input limit')
        except Exception:
            destination.unlink(missing_ok=True)
            raise
        return {'source':str(source),'sourceSHA256':hashlib.sha256(source.read_bytes()).hexdigest(),
                'output':str(destination),'outputSHA256':hashlib.sha256(destination.read_bytes()).hexdigest(),
                'selectedFiles':len(selected),'expandedBytes':sum(e.file_size for e,_ in selected),
                'omittedFiles':len(entries)-len(selected),'metadataModified':False,
                'licensing':'Local user-authorized validation only; preserve source notices; no distribution clearance'}

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source',type=Path)
    parser.add_argument('destination',type=Path)
    args=parser.parse_args()
    print(json.dumps(import_model(args.source,args.destination),ensure_ascii=False,indent=2))
