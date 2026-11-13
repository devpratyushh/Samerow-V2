#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Build a deterministic install ZIP and optionally a verified catalog manifest."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import urllib.parse
import urllib.request
import uuid
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--source-url", help="Published HTTPS ZIP URL, verified before generating a catalog entry")
args = parser.parse_args()
root = Path(__file__).resolve().parent
assembly = root / "bin/Release/net10.0/SameRow.Plugin.dll"
metadata = root / "meta.json"
if not assembly.exists() or not metadata.exists():
    raise SystemExit("Build the plugin in Release mode before packaging.")
meta = json.loads(metadata.read_text())
uuid.UUID(meta["guid"])
for key in ("version", "targetAbi"):
    if len(meta[key].split(".")) != 4 or not all(part.isdigit() for part in meta[key].split(".")):
        raise SystemExit(f"Invalid {key}")
timestamp = datetime.datetime.fromisoformat(meta["timestamp"].replace("Z", "+00:00"))
output = root / "dist"
output.mkdir(exist_ok=True)
archive = output / f"SameRow-Connect-{meta['version']}.zip"
tag = f"samerow-connect-v{meta['version']}"
source = (
    "SameRow Connect — GPL-3.0-or-later\n"
    f"Source and build/test instructions: https://github.com/devpratyushh/Samerow-V2/tree/{tag}/jellyfin-plugin-samerow\n"
    f"Corresponding source archive: https://github.com/devpratyushh/Samerow-V2/releases/download/{tag}/SameRow-Connect-{meta['version']}-source.tar.gz\n"
    "See LICENSE and LICENSING.md for terms and scope. Jellyfin server assemblies are not bundled.\n"
).encode()
with zipfile.ZipFile(archive, "w") as package:
    for filename, data in [("SameRow.Plugin.dll", assembly.read_bytes()), ("meta.json", metadata.read_bytes()), ("LICENSE", (root / "LICENSE").read_bytes()), ("LICENSING.md", (root / "LICENSING.md").read_bytes()), ("SOURCE.txt", source)]:
        info = zipfile.ZipInfo(filename, timestamp.timetuple()[:6])
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        package.writestr(info, data)
data = archive.read_bytes()
archive.with_suffix(".zip.sha256").write_text(f"{hashlib.sha256(data).hexdigest()}  {archive.name}\n")
if args.source_url:
    url = urllib.parse.urlparse(args.source_url)
    if url.scheme != "https" or url.username or url.password:
        raise SystemExit("Use a published HTTPS ZIP URL.")
    with urllib.request.urlopen(args.source_url, timeout=30) as response:
        if response.read(len(data) + 1) != data:
            raise SystemExit("Published ZIP differs from this artifact.")
    version = {key: meta[key] for key in ("version", "targetAbi", "changelog", "timestamp")}
    version.update(sourceUrl=args.source_url, checksum=hashlib.md5(data).hexdigest())
    entry = {key: meta[key] for key in ("guid", "name", "description", "overview", "owner", "category")}
    entry["versions"] = [version]
    (output / "manifest.json").write_text(json.dumps([entry], indent=2) + "\n")
print(archive)
