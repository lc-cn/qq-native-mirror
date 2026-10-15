#!/usr/bin/env python3
"""Offline ELF string-address and AArch64 ADRP/ADD xref inventory; never loads code."""
import hashlib, json, struct, sys
from pathlib import Path
p=Path(sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node')
b=p.read_bytes()
if hashlib.sha256(b).hexdigest()!='c302361f52494de257044e912e43ed244bb29ee59f59345d25a8959327828337':
 raise SystemExit('Version-specific address map: binary SHA-256 mismatch')
if b[:6]!=b'\x7fELF\x02\x01': raise SystemExit('Requires little-endian ELF64')
e_machine=struct.unpack_from('<H',b,18)[0]
shoff=struct.unpack_from('<Q',b,40)[0];shentsize,shnum,shstr=struct.unpack_from('<HHH',b,58)
sections=[struct.unpack_from('<IIQQQQIIQQ',b,shoff+i*shentsize) for i in range(shnum)]
names=sections[shstr];table=b[names[4]:names[4]+names[5]]
def name(s): return table[s[0]:].split(b'\0',1)[0].decode()
sec={name(s):s for s in sections}
queries=[
'Security sign callback is nullptr, will not sign!',
'MSFSign is failed, will not sign! cmd:{} data size:{}',
'MSFSign is success, cmd:{} data size:{}, {}',
'Unknown security sign type, type:{}',
'SendMsfRequestInternal security_sign_callback_ is null, cmd={} seq={}',
'MSFSign failed, module_id:{} data:{}',
'../../wrapper/external/msf/msf_security_sign_callback.cc',
'../../modules/group_pro/modules/msf-ng/msf/security/internal/security_sign_manager.cc',
'msfsecuritysign_type','cSecurityModule.cpp',
]
results=[];targets={};calls={0x40614e4:[],0x4060ebc:[],0x412d448:[],0x42627dc:[]}
for text in queries:
 start=0
 while True:
  off=b.find(text.encode()+b'\0',start)
  if off<0:break
  owner=next((s for s in sections if s[4]<=off<s[4]+s[5] and s[1]!=8),None)
  address=owner[3]+off-owner[4] if owner else None
  item={'string':text,'fileOffset':hex(off),'virtualAddress':hex(address) if address is not None else None,'references':[]}
  results.append(item)
  if address is not None:targets[address]=item
  start=off+1
if e_machine==183 and '.text' in sec:
 text=sec['.text'];code=memoryview(b)[text[4]:text[4]+text[5]];pages={a&~4095 for a in targets}
 for index,(ins,) in enumerate(struct.iter_unpack('<I',code[:len(code)//4*4])):
  pc=text[3]+index*4
  if ins&0xfc000000==0x94000000:
   immediate=ins&0x3ffffff
   if immediate&0x2000000:immediate-=0x4000000
   destination=pc+immediate*4
   if destination in calls:calls[destination].append(hex(pc))
  if ins&0x9f000000!=0x90000000:continue
  imm=((ins>>5)&0x7ffff)<<2|((ins>>29)&3)
  if imm&0x100000:imm-=0x200000
  pc=text[3]+index*4;page=(pc&~4095)+(imm<<12)
  if page not in pages:continue
  reg=ins&31
  for delta in range(1,5):
   if (index+delta)*4+4>len(code):break
   add=struct.unpack_from('<I',code,(index+delta)*4)[0]
   if add&0xff000000==0x91000000 and ((add>>5)&31)==reg:
    address=page+((add>>10)&4095)*(4096 if add&(1<<22) else 1)
    if address in targets: targets[address]['references'].append({'adrp':hex(pc),'add':hex(pc+delta*4),'register':reg})
print(json.dumps({'binary':str(p),'elfMachine':e_machine,'method':'ADRP plus ADD within four instructions; incomplete heuristic, not call-flow proof','directCalls':{hex(k):v for k,v in calls.items()},'strings':results},indent=2))
