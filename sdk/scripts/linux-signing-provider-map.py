#!/usr/bin/env python3
"""Static instruction/relocation inventory, never invokes provider or native code."""
import contextlib,io,runpy,struct,json,bisect
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-init-map.py')
b=e['b'];base=e['e'];sections=base['ss'];names=base['names'];starts=e['starts']
text=next(s for s in sections if names[s[0]:].split(b'\0',1)[0]==b'.text')
start=0x42627dc;i=bisect.bisect_right(starts,start)-1;end=starts[i+1]
def instruction(a):return struct.unpack_from('<I',b,text[4]+a-text[3])[0]
checks={0x426283c:0xaa1e03e0,0x426285c:0x1a9f07e9,0x4262874:0x3901bfe9,0x4262940:0x3901ffe9,0x4262b0c:0x0a090108,0x4262c50:0xb906d93f,0x4262c68:0xb906d92d,0x4262e98:0x2a1f03e0}
for a,v in checks.items():
 if instruction(a)!=v:raise SystemExit(f'Instruction mismatch at {hex(a)}')
calls=[];returns=[];indirect=[]
for a in range(start,end,4):
 w=instruction(a)
 if w&0xfc000000==0x94000000:
  x=w&0x3ffffff;x=x-0x4000000 if x&0x2000000 else x;calls.append({'site':hex(a),'target':hex(a+x*4)})
 if w&0xfffffc1f==0xd65f0000:returns.append(hex(a))
 if w&0xfffffc1f in (0xd61f0000,0xd63f0000):indirect.append(hex(a))
print(json.dumps({'sha256':base['expected'],'range':[hex(start),hex(end)],'returns':returns,'indirectBranchSites':indirect,'directCalls':calls,'callerImagePredicate':{'dladdr':'0x4262840','imageFilenameStorage':'sp+0x70','successAndNonempty':'0x4262b0c','strstr':'0x4262dd4'},'globalWrites':{'virtualAddress':'0x89e36d8','zeroAt':'0x4262c50','oneAt':'0x4262c68','meaning':'unknown; not assigned detection/fake-sign semantics'},'returnCaution':'Only normal RET is preceded by w0=0; does not prove authenticity or internal operation success'},indent=2))
