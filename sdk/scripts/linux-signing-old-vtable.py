#!/usr/bin/env python3
"""Independently resolve one older ARM64 callback RTTI/vtable; bytes only."""
import hashlib,struct,json,sys
from pathlib import Path
p=Path(sys.argv[1] if len(sys.argv)>1 else '.local/native/qq-3.2.31-linux-arm64/wrapper.node');b=p.read_bytes();expected='72978494d18d0076a378550099628569ff5081ada79f37e0b7adaeae6904217a'
if hashlib.sha256(b).hexdigest()!=expected:raise SystemExit('Older binary hash mismatch')
o=struct.unpack_from('<Q',b,40)[0];z,n,si=struct.unpack_from('<HHH',b,58);ss=[struct.unpack_from('<IIQQQQIIQQ',b,o+i*z) for i in range(n)];ns=ss[si];names=b[ns[4]:ns[4]+ns[5]]
def section(n):return next(s for s in ss if names[s[0]:].split(b'\0',1)[0]==n)
r=section(b'.rela.dyn');rels={a:(i&0xffffffff,v) for a,i,v in struct.iter_unpack('<QQq',b[r[4]:r[4]+r[5]])}
needle=b'N2nt8internal23MSFSecuritySignCallbackE\0';f=b.index(needle);s=next(s for s in ss if s[4]<=f<s[4]+s[5] and s[1]!=8);nameaddr=s[3]+f-s[4]
nameptrs=[a for a,(k,v) in rels.items() if k==1027 and v==nameaddr]
if len(nameptrs)!=1:raise SystemExit('Ambiguous RTTI name')
ti=nameptrs[0]-8;slots=[a for a,(k,v) in rels.items() if k==1027 and v==ti]
if len(slots)!=1:raise SystemExit('Ambiguous vtable RTTI')
base=slots[0]-8;point=base+16;method=rels[point+16]
if method[0]!=1027:raise SystemExit('Unexpected method relocation')
t=section(b'.text');start=method[1]
h=section(b'.eh_frame_hdr');raw=b[h[4]:h[4]+h[5]]
if raw[:4]!=bytes([1,0x1b,3,0x3b]):raise SystemExit('Unexpected unwind encoding')
c=struct.unpack_from('<I',raw,8)[0];starts=[h[3]+a for a,f in struct.iter_unpack('<ii',raw[12:12+c*8])];end=starts[starts.index(start)+1]
calls=[]
for pc in range(start,end,4):
 w=struct.unpack_from('<I',b,t[4]+pc-t[3])[0]
 if w&0xfc000000==0x94000000:
  x=w&0x3ffffff;x=x-0x4000000 if x&0x2000000 else x;calls.append({'site':hex(pc),'target':hex(pc+x*4)})
checks={0x11df64c:0x94ab9fec,0x11df654:0x340002e0,0x11df6b0:0x39447fe2,0x11df6c8:0x39487fe2,0x11df6d8:0x394c7fe2}
for a,w in checks.items():
 if struct.unpack_from('<I',b,t[4]+a-t[3])[0]!=w:raise SystemExit('Method-context instruction mismatch')
print(json.dumps({'providerCandidate':{'callSite':'0x11df64c','target':'0x3cc75fc','zeroReturnBranch':'0x11df654','outputCopyLengthLoads':['0x11df6b0','0x11df6c8','0x11df6d8']},'sha256':expected,'typeName':needle[:-1].decode(),'nameAddress':hex(nameaddr),'typeinfo':hex(ti),'vtableBase':hex(base),'vtableAddressPoint':hex(point),'signMethodSlot':hex(point+16),'methodRange':[hex(start),hex(end)],'directBLCalls':calls,'claim':'Independent older callback structure only; provider identification requires inspecting method call context, no execution/safety claim'},indent=2))
