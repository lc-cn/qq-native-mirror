#!/usr/bin/env python3
"""One older pre-provider function: bounded static stores, never loads native code."""
import contextlib,io,runpy,struct,json,bisect
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-old-vtable.py')
b,t=e['b'],e['t'];start=0x3cc13e8;i=bisect.bisect_right(e['starts'],start)-1
if e['starts'][i]!=start or e['starts'][i+1]!=0x3cc1b10:raise SystemExit('Unwind range mismatch')
checks={0x3cc141c:0xaa0203f5,0x3cc1420:0xaa0103f3,0x3cc1424:0xaa0003f4,0x3cc1a50:0x94000030,0x3cc1a64:0xa9005414,0x3cc1a68:0xf9000813,0x3cc1a6c:0x39006016,0x3cc1a88:0xa9012d2a,0x3cc1a9c:0xd63f0100,0x3cc1abc:0xa9012d2a,0x3cc1adc:0xd63f0100}
for a,w in checks.items():
 if struct.unpack_from('<I',b,t[4]+a-t[3])[0]!=w:raise SystemExit(f'Instruction mismatch {hex(a)}')
print(json.dumps({'sha256':e['expected'],'functionRange':[hex(start),'0x3cc1b10'],'argumentsSaved':{'x0':'x20','x1':'x19','x2':'x21'},'returnedObjectWrites':{'objectSource':'x0 return from call 0x3cc1a50->0x3cc1b10; callee not inspected','offset0':'original x0','offset8':'original x2','offset16':'original x1','offset24':'byte 1'},'globalPointerRelocations':{hex(a):hex(e['rels'][a][1]) for a in [0x80af568,0x80acb80]},'callbackLikeGlobalStores':[{'site':'0x3cc1a88','functions':['0x3d79e10','0x3d79d5c']},{'site':'0x3cc1abc','functions':['0x3d79f84','0x3d79e24']}],'conditionalIndirectCalls':['0x3cc1a9c','0x3cc1adc'],'limits':'Stores callback-like pairs and invokes existing non-null slot with operation word 3. Slot ABI/semantics and helper operations unknown; cannot claim stores-only.'},indent=2))
