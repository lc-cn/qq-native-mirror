#!/usr/bin/env python3
"""Exact-hash, single-function indexed lookup evidence; never executes ELF."""
import bisect,contextlib,io,json,runpy
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction'];start,stop=0x4331760,0x4331848
i=bisect.bisect_left(e['starts'],start)
assert e['starts'][i:i+2]==[start,stop]
checks={0x4331764:0xa941a40c,0x4331770:0xf940080a,
 0x4331778:0x38616992,0x43317d8:0x7200023f,0x43317dc:0x1a8e01b1,
 0x4331800:0xf9000bea,0x433180c:0xf9400ff1,0x4331810:0xf8717920,
 0x4331818:0xaa1f03e0,0x4331828:0xf9400bf1,0x433182c:0xf8617a32,
 0x4331838:0xf9000ff2,0x4331844:0xd65f03c0}
for pc,w in checks.items():
 if ins(pc)!=w:raise SystemExit(f'Instruction mismatch {pc:#x}')
calls=[];returns=[]
for pc in range(start,stop,4):
 w=ins(pc)
 if w&0xfc000000==0x94000000 or w&0xfffffc1f in (0xd61f0000,0xd63f0000):calls.append(hex(pc))
 if w&0xfffffc1f==0xd65f0000:returns.append(hex(pc))
assert not calls and returns==['0x4331844']
print(json.dumps({'sha256':e['base']['expected'],'range':[hex(start),hex(stop)],
 'exactWords':{hex(a):hex(w)for a,w in checks.items()},'calls':calls,'returns':returns,
 'entryContract':{'x0':'owner pointer','x1':'index unchanged throughout bounded body',
  'fields':{'owner+0x10':'x10: index-table pointer','owner+0x18':'x12: byte-table pointer','owner+0x20':'x9: pointer-table base'}},
 'returnMapping':{'byteGate':'(byteTable[index] & 1)==0 selects null route',
  'nonzeroGate':'index2 = uint64 indexTable[index]; x0 = uint64 pointerTable[index2]',
  'sites':['0x4331778 byte load','0x43317d8 bit0 test','0x433182c first table load','0x4331810 second table load','0x4331818 null']},
 'effects':'Only local stack stores. No allocation, callback, relocation load or external memory write in bounded body.',
 'conclusion':'Returns an existing double-indexed table entry, not a directly computed byte-buffer address. Native type of entry and entry+8 data pointer are not determined here.',
 'limits':'No bounds check established. Caller must provide valid index/tables. No provider+0x200 alias, payload ownership, OR8 propagation or server-marker meaning established. Adjacent functions excluded.'},indent=2))
