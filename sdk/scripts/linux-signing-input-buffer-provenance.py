#!/usr/bin/env python3
"""Verify a pinned input-pointer chain without loading native code.

The output describes static instructions, not reachable runtime paths or signing
semantics. This research tool is excluded from the npm package.
"""

import argparse
import hashlib
import json
import re
import struct
import subprocess
from pathlib import Path


BINARY_SHA256 = "c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337"
BLOB_SHA256 = "fe1623668335f3f6dce1065e72349da9d71262bd31ba61f7be42e1da1aa8d976"
WINDOWS = (
    (0x4332598, 0x4332614, "23ba09b3e301a011bffbd4d6e6435a567d54124f771794b31bfb8b7cd7b0420c"),
    (0x4332614, 0x43326BC, "f6ac780c727f53ebbf645c3e4831435e0399bbb7465c56c13c0dcdf4aaca6ade"),
    (0x43336A8, 0x43336D4, "3294ea01981b6e7818b4f712562f2d9ec79266a27475f6a4439c4c1a15eafceb"),
    (0x4334230, 0x433428C, "9bab8cb9da6c8c4663e1c7d6fbfc861e1f909ac54f2124e5f698ea8861d4df0f"),
    (0x4334048, 0x43340E0, "465f292859159ca93b1407b491a050c911e25b05f67ed30b8c9cb0f5ca382b4c"),
    (0x43363F4, 0x4336444, "ccb5c4868461184ea1b5502856f754d218afeefca494d66705e8cfac92fc9679"),
    (0x4331760, 0x4331848, "921210f8a894797f81ba9c3c1494c3bce52f673759b05b1bd81fb81677572cd9"),
    (0x434E864, 0x434E9C4, "d5ef9567b972e82f38d3c1f03100db521b86fe707122cf02dfa6374c2ec36467"),
    (0x4337340, 0x4337368, "8e8c92dd457793965794b3ae48cfb75a41106690bd97d9b63521bceeaca6e435"),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(path, objdump):
    data = path.read_bytes()
    require(hashlib.sha256(data).hexdigest() == BINARY_SHA256, "Binary SHA-256 mismatch")
    require(data[:6] == b"\x7fELF\x02\x01", "Expected little-endian ELF64")
    require(struct.unpack_from("<H", data, 18)[0] == 183, "Expected AArch64")
    offset = struct.unpack_from("<Q", data, 40)[0]
    size, count, names_index = struct.unpack_from("<HHH", data, 58)
    headers = [struct.unpack_from("<IIQQQQIIQQ", data, offset + i * size) for i in range(count)]
    names_header = headers[names_index]
    names = data[names_header[4]:names_header[4] + names_header[5]]
    sections = {names[s[0]:].split(b"\0", 1)[0]: s for s in headers}

    def readva(address, length):
        section = next(s for s in headers if s[1] != 8 and s[3] <= address
                       and address + length <= s[3] + s[5])
        start = section[4] + address - section[3]
        return data[start:start + length]

    def word(address):
        return struct.unpack("<I", readva(address, 4))[0]

    header = sections[b".eh_frame_hdr"]
    unwind = readva(header[3], header[5])
    require(unwind[:4] == bytes((1, 0x1B, 3, 0x3B)), "Unrecognized unwind encoding")
    count = struct.unpack_from("<I", unwind, 8)[0]
    starts = [header[3] + a for a, _ in struct.iter_unpack("<ii", unwind[12:12 + count * 8])]
    for start, stop in ((0x4332598, 0x4332614), (0x4332614, 0x4334048),
                        (0x4334048, 0x433BF80), (0x4331760, 0x4331848),
                        (0x434E864, 0x434E9C4)):
        index = starts.index(start)
        require(starts[index + 1] == stop, "Unwind range changed")

    windows = []
    for start, stop, expected in WINDOWS:
        raw = readva(start, stop - start)
        require(hashlib.sha256(raw).hexdigest() == expected, "Instruction window changed")
        output = subprocess.check_output(
            [str(objdump), "-d", f"--start-address={start:#x}",
             f"--stop-address={stop:#x}", str(path)], text=True,
        )
        decoded = {int(a, 16): int(w, 16) for a, w in re.findall(
            r"^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s", output, re.M)}
        require(decoded == {pc: word(pc) for pc in range(start, stop, 4)},
                "Incomplete or mismatched objdump instructions")
        windows.append({"range": [hex(start), hex(stop)], "sha256": expected,
                        "instructionCount": len(decoded),
                        "words": [{"at": hex(pc), "word": hex(w)}
                                  for pc, w in decoded.items()]})

    # This exact scan establishes only literal immediate branch references.
    references = {0x4332598: [], 0x4332614: [], 0x434E864: []}
    text = sections[b".text"]
    for index, (instruction,) in enumerate(struct.iter_unpack("<I", readva(text[3], text[5]))):
        if instruction & 0x7C000000 != 0x14000000:
            continue
        delta = instruction & 0x3FFFFFF
        if delta & 0x2000000:
            delta -= 0x4000000
        pc = text[3] + index * 4
        target = pc + delta * 4
        if target in references:
            references[target].append({"at": hex(pc),
                                       "kind": "BL" if instruction & 0x80000000 else "B"})
    require(references == {
        0x4332598: [],
        0x4332614: [{"at": "0x43325e4", "kind": "BL"},
                    {"at": "0x4336440", "kind": "BL"}],
        0x434E864: [{"at": "0x43336d0", "kind": "BL"}],
    }, "Direct branch reference set changed")

    def address_delta(instruction):
        delta = ((instruction >> 29) & 3) | (((instruction >> 5) & 0x7FFFF) << 2)
        return delta - 0x200000 if delta & 0x100000 else delta

    # Bind the table and destination base to the actual checked dispatcher,
    # rather than relying on a table offset in isolation.
    table_page = (0x4337350 & ~4095) + (address_delta(word(0x4337350)) << 12)
    table_address = table_page + ((word(0x4337354) >> 10) & 4095)
    destination_base = 0x4337358 + address_delta(word(0x4337358))
    require(table_address == 0x6C7E59E and destination_base == 0x4334230,
            "Dispatcher address binding changed")
    table = readva(table_address, 256)
    require(hashlib.sha256(table).hexdigest() ==
            "0e5b7d0e329515863b5e947f409f7d2cc7b5bed5e777ad584070b1da08079a3f",
            "Opcode table changed")
    destination = destination_base + struct.unpack_from("<H", table, 0x7B * 2)[0] * 4
    require(destination == 0x4334230, "Opcode 0x7b target changed")
    blob = readva(0x6C7E29C, 378)
    require(hashlib.sha256(blob).hexdigest() == BLOB_SHA256, "Static blob changed")
    require(0x7B not in blob, "Unexpected opcode byte in static blob")

    return {
        "binarySha256": BINARY_SHA256,
        "windows": windows,
        "instructionCount": sum(w["instructionCount"] for w in windows),
        "directBranchReferences": {hex(k): v for k, v in references.items()},
        "pointerEdges": [
            "4332640 saves original x1 at frame+18; 43336b0 reloads it into x23.",
            "43336bc reloads original object x0; 43336c0 passes x23 as mutator x1.",
            "43325ac saves wrapper input x0 in x20; 43325d4 passes it as helper x1.",
            "4334248 looks up a record using instruction byte1 low four bits.",
            "4334258 loads record+8; 4334280 saves that pointer at consumer frame+5b0.",
            "4336404 reloads frame+5b0 into x24; 4336418 passes it as helper x1.",
            "4331760 uses flag, index and pointer tables; it does not allocate a record.",
        ],
        "staticOpcode": {"value": "0x7b", "destination": hex(destination),
                         "tableAddress": hex(table_address),
                         "destinationBase": hex(destination_base),
                         "blobSha256": BLOB_SHA256, "rawByteOffsets": []},
        "limits": [
            "A stack slot saves a pointer; it does not establish stack-allocated data.",
            "No independent allocation or first-48-byte non-aliasing is established.",
            "The direct branch scan excludes indirect and computed references.",
            "Static byte absence does not prove runtime code immutability or unreachability.",
            "Flattened branch ordering, record identity and final output propagation remain unproven.",
        ],
        "nativeExecuted": False,
        "accountUsed": False,
        "signingAuthenticityEstablished": False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--objdump", type=Path, default=Path("/usr/bin/objdump"))
    options = parser.parse_args()
    # Publish no partial evidence if any hash, decoding or tool check fails.
    try:
        receipt = verify(options.binary, options.objdump)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        raise SystemExit(f"Static verification failed: {error}") from error
    print(json.dumps(receipt, indent=2))


if __name__ == "__main__":
    main()
