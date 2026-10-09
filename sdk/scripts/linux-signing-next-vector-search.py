#!/usr/bin/env python3
"""Bounded static inspection of one known setup vector-search callee."""
import bisect, contextlib, io, json, runpy
with contextlib.redirect_stdout(io.StringIO()):
    e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction'];start=0x434dda0;stop=0x434e45c
i=bisect.bisect_left(e['starts'],start)
assert e['starts'][i:i+2]==[start,stop]
checks={0x434ddc4:0xf90003e2,0x434de3c:0xd10063b6,
 0x434de50:0xd10043b2,0x434dea4:0xf81f03a0,0x434dea8:0xf90007f6,
 0x434df88:0xf94007ef,0x434df90:0xf94003f1,0x434df98:0xf90001f1,
 0x434df3c:0xf94001ef,0x434df40:0xf9400318,0x434df44:0xeb1801ff,
 0x434e220:0xf81d83b2,0x434e26c:0xf85d83af,0x434e270:0xf94001e0,
 0x434e2a8:0xf85f03af,0x434e2ac:0xcb0f002f,0x434e2b0:0x9343fdf8,
 0x434e2dc:0x910021ef,0x434e2e0:0xf81f03af,
 0x434e454:0xd65f03c0,0x434e458:0x9713bc3a}
for pc,w in checks.items():
    if ins(pc)!=w:raise SystemExit(f'Instruction mismatch {pc:#x}')
calls=[];returns=[];indirect=[]
for pc in range(start,stop,4):
    w=ins(pc)
    if w&0xfc000000==0x94000000:
        n=w&0x3ffffff
        if n&0x2000000:n-=0x4000000
        calls.append({'at':hex(pc),'target':hex(pc+n*4)})
    if w&0xfffffc1f==0xd65f0000:returns.append(hex(pc))
    if w&0xfffffc1f in (0xd61f0000,0xd63f0000):indirect.append(hex(pc))
assert calls==[{'at':'0x434e458','target':'0x83d540'}]
assert returns==['0x434e454'] and not indirect
print(json.dumps({'sha256':e['base']['expected'],'range':[hex(start),hex(stop)],
 'selectedExactWords':{hex(a):hex(w)for a,w in checks.items()},
 'calls':calls,'returns':returns,'indirectBranches':indirect,
 'localDataflow':[
  {'at':'0x434dea4','effect':'original x0 (range begin) -> local x29-0x10'},
  {'at':'0x434df88..0x434df98','effect':'original x2 copied from sp+0 into local x29-0x18 through saved local pointer'},
  {'at':'0x434df3c..0x434df44','effect':'load two 64-bit values through candidate and target pointers, compare equality'},
  {'at':'0x434e2a8..0x434e2b0','effect':'remaining count = (original x1 - local iteration pointer) arithmetic-shift-right 3'},
  {'at':'0x434e2dc..0x434e2e0','effect':'local iteration pointer += 8'},
  {'at':'0x434e220','effect':'save address of iteration-pointer local x29-0x10 at local x29-0x28'},
  {'at':'0x434e26c..0x434e270','effect':'x0 return gets iteration pointer through local x29-0x28'}],
 'interpretation':'Consistent with an 8-byte-element equality search returning a position in the supplied range; exact all-path termination/reachability was not symbolically proven.',
 'scopeLimit':'Only this unwind-bounded body inspected. No signing/byte transformation call or input payload write identified in the inspected body. No provider+0x200 argument/alias is established. OR8-object propagation, vendor class schema, signing semantics and server marker remain unknown. No native execution.'},indent=2))
