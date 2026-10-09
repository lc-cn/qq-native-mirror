#!/usr/bin/env python3
"""Verify selected relocation/RTTI chain in the exact inspected Linux arm64 ELF."""
import hashlib,json,struct,sys
from pathlib import Path
p=Path(sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node');b=p.read_bytes()
expected='c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337'
if hashlib.sha256(b).hexdigest()!=expected:raise SystemExit('Version-specific address map: binary SHA-256 mismatch')
so=struct.unpack_from('<Q',b,40)[0];sz,n,si=struct.unpack_from('<HHH',b,58)
ss=[struct.unpack_from('<IIQQQQIIQQ',b,so+i*sz) for i in range(n)];ns=ss[si];names=b[ns[4]:ns[4]+ns[5]]
rel=next(s for s in ss if names[s[0]:].split(b'\0',1)[0]==b'.rela.dyn')
relocations={a:(i&0xffffffff,v) for a,i,v in struct.iter_unpack('<QQq',b[rel[4]:rel[4]+rel[5]])}
po=struct.unpack_from('<Q',b,32)[0];psz,pn=struct.unpack_from('<HH',b,54)
ps=[struct.unpack_from('<IIQQQQQQ',b,po+i*psz) for i in range(pn)]
def string(a):
 s=next(s for s in ps if s[0]==1 and s[3]<=a<s[3]+s[5]);f=s[2]+a-s[3]
 return b[f:].split(b'\0',1)[0].decode()
def target(a):
 kind,v=relocations[a]
 if kind!=1027:raise ValueError('Expected R_AARCH64_RELATIVE')
 return v
base=target(0x89de348);ti=target(base+8);type_name=target(ti+8)
print(json.dumps({
 'sha256':expected,'callbackGOT':'0x89de348','vtableBase':hex(base),
 'vtableAddressPoint':hex(base+16),'typeinfo':hex(ti),'typeName':string(type_name),
 'signMethodSlot':hex(base+32),'signMethodTarget':hex(target(base+32)),
 'callbackSharedControlVtable':'0x8718698',
 'setterCallSites':['0x1379124','0x137a888','0x139cea4','0x139df1c'],
 'claim':'Static constructed callback identity only; no runtime execution or signature validity claim',
},indent=2))
