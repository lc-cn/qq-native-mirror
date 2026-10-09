#!/usr/bin/env python3
"""Pinned input record and nested consumer boundary; never executes native code."""
import bisect, contextlib, hashlib, io, json, re, runpy, struct, subprocess, sys

with contextlib.redirect_stdout(io.StringIO()):
    e = runpy.run_path('scripts/linux-signing-provider-map.py')
b, sections, names = e['b'], e['sections'], e['names']
path = sys.argv[1] if len(sys.argv) > 1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'

def raw(address, length):
    s = next(s for s in sections if s[3] <= address and address + length <= s[3] + s[5])
    offset = s[4] + address - s[3]
    return b[offset:offset + length]

def section(name):
    return next(s for s in sections if names[s[0]:].split(b'\0', 1)[0] == name)

# Bind external call names to actual PLT instructions and dynamic relocations.
rel, sym, strings = section(b'.rela.plt'), section(b'.dynsym'), section(b'.dynstr')
assert rel[9] == sym[9] == 24
relocations = {a: info for a, info, _ in struct.iter_unpack('<QQq', b[rel[4]:rel[4] + rel[5]])}
plt = []
for address, got, label in [(0x83a7c0, 0x89e0220, 'malloc'),
                            (0x83a700, 0x89e01c0, 'memcpy'),
                            (0x83a5f0, 0x89e0138, 'memset')]:
    words = struct.unpack('<4I', raw(address, 16))
    assert words[0] == 0xd0040d30 and words[3] == 0xd61f0220
    assert words[1] == (0xf9400211 | (((got - 0x89e0000) // 8) << 10))
    assert words[2] == (0x91000210 | ((got - 0x89e0000) << 10))
    info = relocations[got]
    assert info & 0xffffffff == 1026  # R_AARCH64_JUMP_SLOT
    string_index = struct.unpack_from('<I', b, sym[4] + (info >> 32) * 24)[0]
    assert b[strings[4] + string_index:strings[4] + strings[5]].split(b'\0', 1)[0] == label.encode()
    plt.append({'address': hex(address), 'got': hex(got), 'symbol': label})

functions = []
for start, stop in [(0x4356e3c, 0x4356f94), (0x4356f94, 0x4357024)]:
    i = bisect.bisect_left(e['starts'], start)
    assert e['starts'][i:i + 2] == [start, stop]
    output = subprocess.check_output(['/usr/bin/objdump', '--disassemble',
        f'--start-address={start:#x}', f'--stop-address={stop:#x}', path], text=True)
    rows, calls, tails, indirect, returns = [], [], [], [], []
    for line in output.splitlines():
        m = re.match(r'\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.+)', line)
        if not m:
            continue
        pc, w = int(m[1], 16), int(m[2], 16)
        assert e['instruction'](pc) == w
        rows.append({'pc': hex(pc), 'word': hex(w), 'instruction': m[3].split(' //')[0].strip()})
        if w & 0xfc000000 in (0x94000000, 0x14000000):
            n = w & 0x3ffffff
            if n & 0x2000000:
                n -= 0x4000000
            target = pc + n * 4
            edge = {'site': hex(pc), 'target': hex(target)}
            if w & 0xfc000000 == 0x94000000:
                calls.append(edge)
            elif not start <= target < stop:
                tails.append(edge)
        if w & 0xfffffc1f in (0xd61f0000, 0xd63f0000):
            indirect.append(hex(pc))
        if w & 0xfffffc1f == 0xd65f0000:
            returns.append(hex(pc))
    assert [int(r['pc'], 16) for r in rows] == list(range(start, stop, 4))
    functions.append({'range': [hex(start), hex(stop)], 'allInstructions': rows,
                      'directCalls': calls, 'externalTailBranches': tails,
                      'indirectBranches': indirect, 'returns': returns})
assert functions[1]['externalTailBranches'] == [{'site': '0x4357020', 'target': '0x4356e3c'}]
assert functions[1]['returns'] == [] and functions[0]['returns'] == ['0x4356f8c']
assert all(not f['indirectBranches'] for f in functions)
template = raw(0x6c7eb40, 3264)
digest = hashlib.sha256(template).hexdigest()
assert digest == '44b70e204ba91b526a4bcbf426c5a4df71d304cd32c20e66118296c910af8260'
tail_digest = hashlib.sha256(raw(0x6c7eb40 + 0xc60, 128)).hexdigest()
assert tail_digest == '266d20daefd0f2b770ea6911cfe156dec5e4b14b08399e2cb22ed6e13ceef082'
global_address = e['base']['target'](0x89dee08)
assert global_address == 0x8a077f0
print(json.dumps({
    'sha256': e['base']['expected'], 'functions': functions, 'verifiedPlt': plt,
    'inputRecord': {'recordBytes': 16, 'lengthAtZero': 'original uint32 w1',
        'uint16AtFour': 32, 'dataPointerAtEight': 'malloc(zeroExtendUint32Length + 1), 64-bit addition',
        'copy': '4357004 memcpy(data, original x0, uint32Length - 1); subtraction wraps at zero',
        'tail': '4357020 -> 4356e3c(x0=static 6f19d2e, x1=inputRecord). This record is an argument, not a proven final return.'},
    'nestedTemplate': {'address': '0x6c7eb40', 'length': 3264, 'sha256': digest,
        'tailRead': {'address': '0x6c7f7a0', 'length': 128, 'sha256': tail_digest},
        'headerUint16': int.from_bytes(template[:2], 'little'),
        'construction': 'Copy template[0:0xc30] to a local buffer; write 48 bytes from the runtime global pointer at local+0xc30; copy 128 static bytes from template+0xc60 to local+0xc60; copy only 0xcc0 bytes of local to the allocated blob.',
        'runtimePointerGot': '0x89dee08', 'runtimeGlobalAddress': hex(global_address),
        'warning': 'Static template digest is not the runtime blob digest: bytes [0xc30,0xc60) are injected. Last 32 bytes of the local tail copy lie beyond the final 0xcc0 copy.'},
    'nestedReturn': ['4356f08 -> 433185c(workspace, constructedBlob)',
        '4356f44 -> 43318f8(workspace, original x0, varargs descriptor carrying inputRecord)',
        '4356f4c -> 4334048(workspace); x0 saved x19',
        '4356f58 cleanup 432fedc(workspace); saved x19 restored to x0 at 4356f74'],
    'limits': 'No execution, reconstructed runtime blob, full nested opcode order, processed return ABI, OR8-byte propagation, crypto algorithm or server marker proof.'
}, indent=2))
