#!/usr/bin/env python3
# Static AArch64 direct addressing heuristic; not runtime state inspection.
import hashlib,struct,json,sys
from pathlib import Path
b=Path(sys.argv[1]).read_bytes()
if hashlib.sha256(b).hexdigest()!='c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337':
 raise SystemExit('Version-specific address map: binary SHA-256 mismatch')
o=struct.unpack_from('<Q',b,40)[0];z,n,i=struct.unpack_from('<HHH',b,58)
s=[struct.unpack_from('<IIQQQQIIQQ',b,o+j*z) for j in range(n)];ns=s[i];names=b[ns[4]:ns[4]+ns[5]]
t=next(v for v in s if names[v[0]:].split(b'\0',1)[0]==b'.text');code=memoryview(b)[t[4]:t[4]+t[5]]
targets={0x8a036a0,0x8a036a8};out=[]
for index,(ins,) in enumerate(struct.iter_unpack('<I',code[:len(code)//4*4])):
 if ins&0x9f000000!=0x90000000:continue
 imm=((ins>>5)&0x7ffff)<<2|((ins>>29)&3)
 if imm&0x100000:imm-=0x200000
 pc=t[3]+index*4;page=(pc&~4095)+(imm<<12);r=ins&31
 if page!=0x8a03000:continue
 for d in range(1,6):
  v=struct.unpack_from('<I',code,(index+d)*4)[0]
  if ((v>>5)&31)!=r:continue
  if v&0xffc00000 in (0xf9400000,0xf9000000):
   a=page+((v>>10)&4095)*8
   if a in targets:out.append({'adrp':hex(pc),'instruction':hex(pc+d*4),'target':hex(a),'operation':'load' if v&(1<<22) else 'store'})
  elif v&0xff000000==0x91000000:
   a=page+((v>>10)&4095)
   if a in targets:out.append({'adrp':hex(pc),'instruction':hex(pc+d*4),'target':hex(a),'operation':'address'})
print(json.dumps(out,indent=2))
