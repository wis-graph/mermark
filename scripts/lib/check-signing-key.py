#!/usr/bin/env python3
"""Verify a minisign .sig file was produced by the private key matching this
app's trusted pubkey (src-tauri/tauri.conf.json -> plugins.updater.pubkey).

Both the pubkey and the .sig are minisign files wrapped once more in base64
(Tauri's convention for embedding them in JSON/TOML). Unwrap once to get
[comment line(s), base64 body line]; decode the body to bytes and compare the
8-byte key id embedded right after the 2-byte algorithm tag.

This is the shared implementation for BOTH release platforms (macOS and
Windows) — scripts/release.sh calls it once per platform's .sig so neither
gets a copy-pasted, silently-drifting duplicate of this logic.

Usage:
    check-signing-key.py <sig_path> [conf_path]

Exit 0 and print "OK" if the key ids match.
Exit 1 and print "MISMATCH pub=<hex> sig=<hex>" otherwise.
Exit 2 on usage/parse errors (message on stderr).
"""
import base64
import json
import sys


def key_id(blob: str) -> bytes:
    """Extract the 8-byte minisign key id from a decoded minisign file body."""
    for line in blob.splitlines():
        line = line.strip()
        if line and not line.lower().startswith(("untrusted comment:", "trusted comment:")):
            return base64.b64decode(line)[2:10]
    raise ValueError("base64 라인을 찾지 못함")


def pubkey_id(conf_path: str) -> bytes:
    pub_b64 = json.load(open(conf_path, encoding="utf-8"))["plugins"]["updater"]["pubkey"]
    return key_id(base64.b64decode(pub_b64).decode())


def sig_id(sig_path: str) -> bytes:
    return key_id(base64.b64decode(open(sig_path, encoding="utf-8").read()).decode())


def main(argv: list) -> int:
    if len(argv) < 2:
        print("usage: check-signing-key.py <sig_path> [conf_path]", file=sys.stderr)
        return 2
    sig_path = argv[1]
    conf_path = argv[2] if len(argv) > 2 else "src-tauri/tauri.conf.json"

    try:
        pub_id = pubkey_id(conf_path)
        sid = sig_id(sig_path)
    except Exception as e:  # noqa: BLE001 - surface any parse failure to the caller
        print(f"오류: 키 ID를 파싱하지 못했습니다: {e}", file=sys.stderr)
        return 2

    if pub_id == sid:
        print("OK")
        return 0
    print(f"MISMATCH pub={pub_id.hex()} sig={sid.hex()}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
