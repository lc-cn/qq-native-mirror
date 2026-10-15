#!/usr/bin/env python3
"""Verify a pinned ELF record-pointer slice without loading native code.

All gates complete before JSON is printed. Runtime record identity, aliasing,
and signing semantics remain unresolved. This research tool is not npm payload.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import subprocess

EXPECTED = 'c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337'
RANGES = [
    (0x4331760, 0x4331848, '921210f8a894797f81ba9c3c1494c3bce52f673759b05b1bd81fb81677572cd9'),
    (0x433185c, 0x4331890, '157e1b83519c8a6f1fb672caf7ca6cf3b8389fad1adfd69ba17be72fe1ee22ec'),
    (0x4331890, 0x43318f8, 'e29110ead92004753e321b8f823a2b37f43cf350aa5f6733d2734ae8237461fd'),
    (0x43318f8, 0x4332284, '68967be04b919c821b1c02adb080182e7af83c9580772f5a10ee35d018e0e5dd'),
    (0x4332284, 0x4332380, 'da7f77d80b04fbdae97ae794672bd4a654e7edbba4cadaab17652b77e44577fa'),
    (0x4332380, 0x4332588, 'aee23e0038ebe3f7544e193d50078c884dabcdd647fe75ec42695f719cd0914e'),
    (0x434daa4, 0x434dc44, '85d926ba46a801d5dbb9ced72611816a01872a0d3aac49398c398fc5b4e7cbe7'),
    (0x434dc5c, 0x434dda0, '578f7a54e9ebd2e176b0936ee07710ca5fec29541220cf8bbadfcb4a1be8a845'),
    (0x434dda0, 0x434e45c, 'a21bcc4f4b746bff3b277a4cdf9a4a6ca8c9ef7f50733b6407878ffc8f099660'),
    (0x434e45c, 0x434e518, '0ea79f434c45a0bf50268a8d45c0d4921dcccb0be859b70274a98bffeda088e9'),
    (0x4356e3c, 0x4356f94, '4663f9676a13c2762a0fb3233e07e9b6ffeacf21ef442a99dc3843ddd44dcf87'),
    (0x4356f94, 0x4357024, '04b63ec9327e570c51ef4a083eb1dc2fbdd744877d8e10de6c43b6a45d6d61f5'),
    (0x42f9558, 0x42f95ac, 'dc051f9a4046d87df5498c7aad413d69213e8460094a7a946b40cbe607f70d8c'),
]
WINDOWS = [
    (0x43318f8, 0x433195c), (0x4331e8c, 0x4331eb0),
    (0x4332124, 0x4332140), (0x43323ac, 0x4332418),
    (0x43324d0, 0x4332538), (0x434dae4, 0x434db08),
    (0x434db90, 0x434dbdc), (0x434dd18, 0x434dd44),
    (0x434dd48, 0x434dd70), (0x434e470, 0x434e508),
    (0x4356fa4, 0x4357024), (0x4356e54, 0x4356e68),
    (0x4356f0c, 0x4356f48), (0x4331760, 0x4331848),
]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(path, objdump):
    data = path.read_bytes()
    require(hashlib.sha256(data).hexdigest() == EXPECTED, 'Binary SHA-256 mismatch')
    require(data[:6] == b'\x7fELF\x02\x01', 'Not little-endian ELF64')
    require(struct.unpack_from('<H', data, 18)[0] == 183, 'Not AArch64')
    offset = struct.unpack_from('<Q', data, 32)[0]
    size, count = struct.unpack_from('<HH', data, 54)
    segments = [struct.unpack_from('<IIQQQQQQ', data, offset + i * size) for i in range(count)]

    def readva(address, length):
        segment = next(s for s in segments if s[0] == 1 and s[3] <= address
                       and address + length <= s[3] + s[5])
        start = segment[2] + address - segment[3]
        return data[start:start + length]

    def word(address):
        return struct.unpack('<I', readva(address, 4))[0]

    offset = struct.unpack_from('<Q', data, 40)[0]
    size, count, names_index = struct.unpack_from('<HHH', data, 58)
    headers = [struct.unpack_from('<IIQQQQIIQQ', data, offset + i * size) for i in range(count)]
    names_header = headers[names_index]
    names = data[names_header[4]:names_header[4] + names_header[5]]
    sections = {names[h[0]:].split(b'\0', 1)[0]: h for h in headers}
    section = sections[b'.eh_frame_hdr']
    unwind = readva(section[3], section[5])
    require(unwind[:4] == bytes([1, 0x1b, 3, 0x3b]), 'Unwind encoding changed')
    count = struct.unpack_from('<I', unwind, 8)[0]
    starts = [section[3] + a for a, _ in struct.iter_unpack('<ii', unwind[12:12 + count * 8])]
    coverage, instructions = [], {}
    for start, stop, expected in RANGES:
        require(starts[starts.index(start) + 1] == stop, f'Unwind range changed: {start:#x}')
        raw = readva(start, stop - start)
        require(hashlib.sha256(raw).hexdigest() == expected, f'Function bytes changed: {start:#x}')
        output = subprocess.check_output([str(objdump), '-d', f'--start-address={start:#x}',
                                          f'--stop-address={stop:#x}', str(path)], text=True)
        rows = [(int(m[1], 16), int(m[2], 16), re.sub(r' <.*?>', '', m[3]).split('//')[0].strip())
                for m in re.finditer(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.+)$', output, re.M)]
        require([a for a, _, _ in rows] == list(range(start, stop, 4)), 'Incomplete objdump range')
        for address, value, text in rows:
            require(value == word(address), f'Objdump differs from PT_LOAD: {address:#x}')
            instructions[address] = text
        coverage.append({'start': hex(start), 'stop': hex(stop), 'sha256': expected,
                         'instructionCount': len(rows)})

    rel = sections[b'.rela.plt']
    relocations = {a: (info, addend) for a, info, addend in struct.iter_unpack('<QQq', readva(rel[3], rel[5]))}
    syms = sections[b'.dynsym']
    strings = sections[b'.dynstr']
    strings = readva(strings[3], strings[5])
    bindings = []
    for pc, expected_name, expected_value in [
        (0x83a460, '_ZNSt6vectorIlSaIlEE12emplace_backIJRlEEES3_DpOT_', 0x434dc5c),
        (0x83bec0, '_ZNSt6vectorIlSaIlEE17_M_realloc_insertIJRlEEEvN9__gnu_cxx17__normal_iteratorIPlS1_EEDpOT_', 0x434e45c),
        (0x83a7c0, 'malloc', 0), (0x83a5f0, 'memset', 0), (0x83a700, 'memcpy', 0),
    ]:
        adrp, ldr, add, branch = [word(pc + i * 4) for i in range(4)]
        require(adrp & 0x9f00001f == 0x90000010 and ldr & 0xffc003ff == 0xf9400211
                and add & 0xffc003ff == 0x91000210 and branch == 0xd61f0220, 'PLT shape changed')
        delta = ((adrp >> 29) & 3) | (((adrp >> 5) & 0x7ffff) << 2)
        if delta & 0x100000:
            delta -= 0x200000
        got = (pc & ~4095) + (delta << 12) + ((ldr >> 10) & 4095) * 8
        require(((add >> 10) & 4095) == ((ldr >> 10) & 4095) * 8, 'PLT ADD changed')
        info, addend = relocations[got]
        require(info & 0xffffffff == 1026 and addend == 0, 'Expected JUMP_SLOT')
        symbol = struct.unpack('<IBBHQQ', readva(syms[3] + (info >> 32) * 24, 24))
        name = strings[symbol[0]:].split(b'\0', 1)[0].decode()
        require(name == expected_name and symbol[4] == expected_value, 'Dynamic binding changed')
        bindings.append({'plt': hex(pc), 'got': hex(got), 'symbol': name, 'definition': hex(symbol[4])})

    rel = sections[b'.rela.dyn']
    globals_ = [(a, info, addend) for a, info, addend in struct.iter_unpack('<QQq', readva(rel[3], rel[5]))
                if a == 0x89dee08]
    require(globals_ == [(0x89dee08, 1027, 0x8a077f0)], 'Global relocation changed')
    require(readva(0x6f19d2e, 3) == b'LL\0', 'Nested descriptor changed')
    # Direct references only: this is not a whole-program reachability proof.
    references = {0x4332380: [], 0x434daa4: []}
    for segment in segments:
        if segment[0] != 1 or not segment[1] & 1:
            continue
        for index, (value,) in enumerate(struct.iter_unpack('<I', readva(segment[3], segment[5] // 4 * 4))):
            if value & 0x7c000000 != 0x14000000:
                continue
            delta = value & 0x3ffffff
            if delta & 0x2000000:
                delta -= 0x4000000
            address = segment[3] + index * 4
            target = address + delta * 4
            if target in references:
                references[target].append(hex(address))
    require(references == {
        0x4332380: ['0x4331ea8', '0x433213c', '0x4335770', '0x43365e8', '0x43377e0',
                    '0x4338658', '0x4339698', '0x4339a04', '0x433a9ec'],
        0x434daa4: ['0x43324f0'],
    }, 'Direct references changed')
    windows = [{'start': hex(start), 'stop': hex(stop), 'sha256': hashlib.sha256(readva(start, stop-start)).hexdigest(),
                'words': [{'at': hex(pc), 'word': f'{word(pc):08x}', 'instruction': instructions[pc]}
                          for pc in range(start, stop, 4)]} for start, stop in WINDOWS]
    return {
        'binarySha256': EXPECTED,
        'mapping': 'ELF PT_LOAD byte reader; adjacent .eh_frame_hdr bounds; system objdump full-word cross-check',
        'coverage': coverage, 'instructionCount': sum(item['instructionCount'] for item in coverage),
        'selectedWindows': windows, 'dynamicBindings': bindings,
        'directReferences': {hex(k): v for k, v in references.items()},
        'globalRelocation': {'got': '0x89dee08', 'global': '0x8a077f0'},
        'facts': [
            'Setup saves workspace x0 in x20 and argument carrier x2 in x19; workspace+8 is the owner passed to 0x4332380 at 0x4331ea8 and 0x433213c. The passed x2 is a loaded 64-bit caller argument, not a newly allocated record.',
            'At 0x4331eac, str x28,[x20,#8] targets workspace+8 (owner+0), not record+8. These unrelated +8 offsets must not be conflated.',
            'The nonzero x2, x3 bit0-clear registration branch stores the supplied pointer in a local at 0x4332410/0x43324dc, passes it to 0x434daa4, and stores the resulting slot index into owner.indexTable[index] at 0x43324fc. The flag is set at 0x4332518.',
            '0x434daa4 searches owner+0x20 through 0x434dda0; the found-entry branch returns (entry-begin)/8, and the append branch returns the old (end-begin)/8 then calls the dynamically bound vector<long>::emplace_back with the saved pointer value.',
            'The vector definition stores the supplied 64-bit value at the old end at 0x434dd24 when capacity exists. Its reallocation definition stores the same supplied value at newBegin+index*8 at 0x434e4cc, then publishes new vector boundaries at 0x434e4fc/0x434e504. Neither selected assignment clones the record or rewrites record+8.',
            'Lookup 0x4331760 uses flag[index]&1, indexTable[index], and owner.recordVector[slot]; its returned value remains the registered record pointer.',
            'One known nested-input constructor allocates a 16-byte record via malloc at 0x4356fb0, allocates data via malloc at 0x4356fcc, and writes that data pointer to record+8 at 0x4356ff0 (f90006b6). It then passes the record as x1 to 0x4356e3c via the tail branch 0x4357020.',
            'Nested entry 0x4356e5c saves incoming x1/x2 in its argument-save area; 0x4356f0c..0x4356f44 forms and passes the carrier to setup. The descriptor starts LL\\0. This proves a known incoming record route, not which record a later consumer opcode selects.',
        ],
        'conclusion': 'Record registration preserves caller-supplied pointer identity. One nested input record has an allocation-backed initial +8 field, but the record selected at 0x4334248 is not proven identical to it. Global first-48-byte aliasing remains unresolved.',
        'nextVerifiableEdge': 'Bind actual instruction byte1&15 at 0x4334240 to the last preceding owner.indexTable write, then trace that registered record supplier and its +8 writes. Consumer contains seven additional direct registration calls besides the two setup sites.',
        'limits': [
            'Byte verification and selected dataflow do not establish every flattened-state order, caller reachability, runtime opcode sequence, bounds, or memory integrity.',
            'The full flattened search body is byte-verified; it is not an independent proof of every possible search execution.',
            'The vector allocation/copy helpers and dynamic allocator implementations are named or retained as call boundaries, not executed or exhaustively expanded; dynamic symbol interposition is not excluded.',
            'Known constructor allocation is not a universal first assignment for every workspace record. Later pointer-table replacement, record mutation, and other callers are not excluded.',
            'No global immutability, alias exclusion, OR8 final-output propagation, signature authenticity, account marking, or kick mechanism is established.',
        ],
        'nativeExecuted': False, 'providerExecuted': False, 'accountUsed': False,
        'global48AliasExcluded': False, 'signingAuthenticityEstablished': False,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--objdump', type=Path, default=Path('/usr/bin/objdump'))
    args = parser.parse_args()
    try:
        receipt = verify(args.binary, args.objdump)
    except (OSError, ValueError, StopIteration, subprocess.SubprocessError) as error:
        raise SystemExit(f'Static verification failed: {error}') from error
    print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
