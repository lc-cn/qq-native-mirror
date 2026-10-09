#!/usr/bin/env python3
"""One hash-pinned static helper body; never executes native code."""
import bisect, contextlib, io, json, runpy
with contextlib.redirect_stdout(io.StringIO()):
    e = runpy.run_path('scripts/linux-signing-provider-map.py')
ins = e['instruction']
start, stop = 0x4332380, 0x4332588
i = bisect.bisect_left(e['starts'], start)
assert e['starts'][i:i+2] == [start, stop], 'Unwind boundary mismatch'
checks = {
    0x43323ac:0xf90007e4, 0x43323b0:0xf100005f,
    0x43323d0:0x7200007f, 0x43323f0:0xaa0103f5,
    0x43323f4:0xaa0003f6, 0x4332410:0xf90003e2,
    0x4332448:0xaa1603e0, 0x433244c:0xf94007e1,
    0x4332450:0x94006bcd, 0x4332484:0xf9400ac8,
    0x4332490:0xf835791f, 0x43324e4:0xf9400fe1,
    0x43324e8:0xd10043a2, 0x43324ec:0xaa1603e0,
    0x43324f0:0x94006d6d, 0x43324f4:0xf85f03a8,
    0x43324f8:0xf9400ac9, 0x43324fc:0xf8357928,
    0x4332510:0xf9400ec8, 0x4332514:0x52800029,
    0x4332518:0x38356909, 0x4332580:0xd65f03c0,
    0x4332584:0x97142bef,
    0x4331ea4:0xf9400fe0, 0x4331ea8:0x94000136,
    0x4331eac:0xf900069c, 0x4332138:0xf9400fe0,
    0x433213c:0x94000091,
}
for a, word in checks.items():
    if ins(a) != word: raise SystemExit(f'Instruction mismatch {a:#x}')
calls, returns = [], []
for pc in range(start, stop, 4):
    w = ins(pc)
    if w & 0xfc000000 == 0x94000000:
        n = w & 0x3ffffff
        if n & 0x2000000: n -= 0x4000000
        calls.append({'at':hex(pc),'target':hex(pc+n*4)})
    if w & 0xfffffc1f == 0xd65f0000: returns.append(hex(pc))
assert calls == [{'at':'0x4332450','target':'0x434d384'},
                 {'at':'0x43324f0','target':'0x434daa4'},
                 {'at':'0x4332584','target':'0x83d540'}]
print(json.dumps({
    'sha256':e['base']['expected'], 'range':[hex(start),hex(stop)],
    'inputSaves':{'x0':'x22 owner; caller supplies workspace+8',
                  'x1':'x21 index; callers supply zero-extended word',
                  'x2':'sp+0 input pointer, null test controls state',
                  'w3':'bit0 controls state', 'x4':'sp+8'},
    'directIndexedWrites':[
        {'at':'0x4332490','effect':'*(uint64_t*)(owner[+0x10] + index*8) = 0'},
        {'at':'0x43324fc','effect':'*(uint64_t*)(owner[+0x10] + index*8) = local[x29-0x10] after callee 0x434daa4'},
        {'at':'0x4332518','effect':'*(uint8_t*)(owner[+0x18] + index) = 1'}],
    'directOwnerFieldStores':'None in this bounded body; indirect callee effects unknown',
    'calls':calls,'namedPLT':'0x83d540 __stack_chk_fail@plt (objdump label)',
    'calleeArgumentMap':{'0x434d384':'x0=owner, x1=original x4',
                         '0x434daa4':'x0=owner, x1=original x2 via local, x2=&local[x29-0x10]'},
    'returns':returns,
    'returnContract':'No explicit final x0 assignment at epilogue; no reliable return-value type assigned; setup ignores it.',
    'limits':'Array-shaped owner fields only. Named container/class, pointed payload semantics, indirect callee writes and OR8-to-provider-output alias remain unknown. Callee bodies not followed; no native execution.'
}, indent=2))
