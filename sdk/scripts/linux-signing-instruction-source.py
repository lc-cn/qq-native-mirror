#!/usr/bin/env python3
"""Pinned static blob-to-workspace-to-consumer provenance, no native execution."""
import contextlib,io,runpy,json,hashlib,struct
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
checks={0x43300b8:0x52802f40,0x43300e4:0x971429b7,
 0x43300e8:0xd0014a61,0x43300ec:0x52802f42,0x43300f0:0x910a7021,
 0x43300f4:0xaa0003f5,0x43300f8:0x97142982,
 0x43300fc:0xd101a3a0,0x4330100:0xaa1503e1,0x4330108:0x940005d5,
 0x4331868:0x79400028,0x433186c:0xaa0003f3,0x4331870:0xf8008401,
 0x4331874:0x2a0803e1,0x4331878:0x94000006,
 0x43340b8:0xf8418528,0x43340c8:0x9100410a,0x43340e0:0xa9022a68}
for a,w in checks.items():
 if e['instruction'](a)!=w:raise SystemExit(f'Instruction mismatch {a:#x}')
address=0x6c7e29c;length=378
s=next(s for s in e['sections'] if s[3]<=address and address+length<=s[3]+s[5])
offset=s[4]+address-s[3];blob=e['b'][offset:offset+length]
digest=hashlib.sha256(blob).hexdigest()
assert digest=='fe1623668335f3f6dce1065e72349da9d71262bd31ba61f7be42e1da1aa8d976'
print(json.dumps({'sha256':e['base']['expected'],
 'exactWords':{hex(a):hex(w)for a,w in checks.items()},
 'blob':{'virtualAddress':hex(address),'fileOffset':hex(offset),'length':length,
  'sha256':digest,'hex':blob.hex(),'initialLittleEndianWords':list(struct.unpack('<4I',blob[:16])),
  'headerUint16AtZero':int.from_bytes(blob[:2],'little'),'instructionStartOffset':16,
  'headerMeaning':'Only uint16 at zero is used as input to owner initializer; other header semantic meanings unknown'},
 'edges':['malloc(378) at 43300e4 retains result x21',
  'memcpy(result, static 6c7e29c, 378) at 43300f8',
  '433185c(workspace=x29-68, copiedBlob=x21) at 4330108',
  '4331870 stores copiedBlob at workspace+0 and advances x0 to workspace+8',
  '4331868 loads uint16 copiedBlob[0] (18), passed to 4331890 owner initialization',
  'consumer 43340b8 loads *(workspace); 43340c8 adds 16; 43340e0 stores that instruction pointer to consumer frame+0x28'],
 'boundary':'At consumer entry the instruction pointer is the copied static blob+16. Intervening setup may mutate owner fields; no exhaustive proof of unmodified blob contents or later branch execution. Header offsets beyond initial uint16 and instruction-start16 have no assigned semantics. OR8/copy lookup equality and provider output effect remain unproven. No native execution.'},indent=2))
