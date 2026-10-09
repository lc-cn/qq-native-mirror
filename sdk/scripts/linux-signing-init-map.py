#!/usr/bin/env python3
"""Offline, version-pinned MSF init vtable and unwind-boundary evidence."""
import bisect, runpy,struct,json,sys,contextlib,io
with contextlib.redirect_stdout(io.StringIO()): e=runpy.run_path('scripts/linux-signing-vtable.py')
b,ss,names,rels=e['b'],e['ss'],e['names'],e['relocations'];target,string=e['target'],e['string']
def section(n):return next(s for s in ss if names[s[0]:].split(b'\0',1)[0]==n)
h=section(b'.eh_frame_hdr');raw=b[h[4]:h[4]+h[5]]
if raw[:4]!=bytes([1,0x1b,3,0x3b]):raise SystemExit('Unsupported unwind header encoding')
count=struct.unpack_from('<I',raw,8)[0]
entries=[(h[3]+a,h[3]+f) for a,f in struct.iter_unpack('<ii',raw[12:12+count*8])];starts=[a for a,f in entries]
rows=[]
for site,slot,tip in [(0x1379124,0x8717470,0x87173e0),(0x137a888,0x8717478,0x87173e0),(0x139cea4,0x8718fe8,0x8718f58),(0x139df1c,0x8718ff0,0x8718f58)]:
 i=bisect.bisect_right(starts,site)-1;start=target(slot)
 if start!=starts[i]:raise SystemExit('Unwind/vtable entry mismatch')
 rows.append({'setterCall':hex(site),'entry':hex(start),'nextUnwindEntry':hex(starts[i+1]),'fde':hex(entries[i][1]),'classRTTI':string(target(target(tip)+8)),'vtableAddressPoint':hex(tip+8),'virtualSlotOffset':hex(slot-tip-8),'directBLCallers':[]})
t=section(b'.text');byentry={int(r['entry'],16):r for r in rows}
for i,(ins,) in enumerate(struct.iter_unpack('<I',b[t[4]:t[4]+t[5]])):
 if ins&0xfc000000==0x94000000:
  x=ins&0x3ffffff;x=x-0x4000000 if x&0x2000000 else x
  pc=t[3]+i*4;dest=pc+x*4
  if dest in byentry:byentry[dest]['directBLCallers'].append(hex(pc))
print(json.dumps({'sha256':e['expected'],'method':'ELF relocation RTTI plus eh_frame_hdr data-relative table; direct BL scan only, indirect calls unresolved','initializers':rows,'sessionInitGuard':{'entry':'0x137a48c','tests':['owner+0x50 at 0x137a4b8','owner+0x60 at 0x137a4c0','arg2 dereference at 0x137a4c8'],'nullBranch':'0x137a840','returnsZeroAt':'0x137a86c','skipsSetter':True}},indent=2))
