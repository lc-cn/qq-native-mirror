#!/usr/bin/env python3
"""Offline version-pinned field consumer and helper ABI register evidence."""
import runpy,contextlib,io,json,bisect
from collections import deque
with contextlib.redirect_stdout(io.StringIO()): e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction'];starts=e['e']['starts'];end=e['text'][3]+e['text'][5]
checks={0x4335ab4:0x90023548,0x4335ac0:0xf944dd08,0x4335ac4:0xb9400108,0x4335ac8:0x7100051f,0x433bda8:0x1a880129}
for a,v in checks.items():
 if ins(a)!=v:raise SystemExit('Instruction mismatch')
rel=e['base']['relocations'][0x89dd9b8]
if rel!=(1027,0x89e36d8):raise SystemExit('GOT mismatch')
helpers=[0x424c350,0x424ab24,0x4239ebc]
def calls(start):
 i=bisect.bisect_right(starts,start)-1;stop=starts[i+1];out=[]
 for pc in range(start,stop,4):
  w=ins(pc)
  if w&0xfc000000==0x94000000:
   n=w&0x3ffffff;n=n-0x4000000 if n&0x2000000 else n;out.append((pc,pc+n*4))
 return out
paths=[]
for helper in helpers:
 q=deque([(helper,[])]);seen=set()
 while q:
  a,path=q.popleft()
  if a in seen or a not in starts or len(path)>3:continue
  seen.add(a)
  if a==0x4334048:paths.append({'helper':hex(helper),'directBLPath':path});break
  for site,dest in calls(a):q.append((dest,path+[{'site':hex(site),'target':hex(dest)}]))
print(json.dumps({'sha256':e['base']['expected'],'global':'0x89e36d8','verifiedRead':{'got':'0x89dd9b8','pointerLoad':'0x4335ac0','valueLoad':'0x4335ac4','compareEqualsOne':'0x4335ac8','stateSelection':'0x433bda8','enclosingFunction':['0x4334048','0x433bf80']},'boundedHelperToConsumerPaths':paths,'callGraphLimit':'direct BL only, depth <=4; absence is not no relationship','helperArgumentsAtProviderCall':{'0x424c350':{'x0':'provider original x0','x1':'decimal-formatted original w3 string object','x2':'original x1/x2 input byte-range string object','x8':'indirect result object address'},'0x424ab24':{'x0':'provider original x0','x1':'input byte-range string object','x8':'indirect result object address'},'0x4239ebc':{'x8':'indirect result object address','otherRegisters':'not assigned a contract; registers modified by prior helper'}},'meaning':'Global influences internal control flow. Logging versus signature output semantics remain unresolved.'},indent=2))
