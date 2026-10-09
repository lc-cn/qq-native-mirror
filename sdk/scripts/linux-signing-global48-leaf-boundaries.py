#!/usr/bin/env python3
"""Two finite static leaf boundaries; does not execute native code."""
import contextlib,io,runpy,struct,json,bisect,hashlib,subprocess,re
with contextlib.redirect_stdout(io.StringIO()):m=runpy.run_path('scripts/linux-signing-global48-mutators.py')
e=m['e'];ins=e['instruction'];label=m['label'];path=m['path'];rows=[]
checks={0x4227090:0xf9400403,0x4227094:0xaa0203e9,0x4227098:0xaa0103e2,0x422709c:0xeb01007f,0x42270a4:0xaa0003e1,0x42270a8:0xaa0803e0,0x42270ac:0xaa0903e3,0x42270b4:0x14034fb2,0x42270c8:0x971854d2,0x4286d34:0xf90007e0,0x4286d3c:0x3940014a,0x4286d40:0x390013ea,0x4286d5c:0x1716d32d}
for a,w in checks.items():assert ins(a)==w
for start,stop in [(0x4227088,0x42270cc),(0x4286d08,0x4286d60)]:
 i=bisect.bisect_left(e['starts'],start);assert e['starts'][i:i+2]==[start,stop]
 words={pc:ins(pc)for pc in range(start,stop,4)}
 args=['/usr/bin/objdump','-d',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path]
 output=subprocess.check_output(args,text=True)
 observed={int(a,16):int(w,16)for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',output,re.M)}
 assert observed==words
 calls=[]
 for pc,w in words.items():
  if w&0x7c000000==0x14000000:
   n=w&0x3ffffff
   if n&0x2000000:n-=0x4000000
   target=pc+n*4
   if start<=target<stop:continue
   calls.append({'at':hex(pc),'word':hex(w),'kind':'BL'if w&0x80000000 else 'tail-B','target':hex(target),'dynamicBinding':label(target)})
 rows.append({'range':[hex(start),hex(stop)],'words':[{'at':hex(a),'word':hex(w)}for a,w in words.items()],
 'instructionCount':len(words),'instructionSha256':hashlib.sha256(b''.join(struct.pack('<I',w)for w in words.values())).hexdigest(),'objdumpCommand':args,'externalDirectBranches':calls})
print(json.dumps({'sha256':e['base']['expected'],'totalInstructions':39,'functions':rows,
'selectedWords':{hex(a):hex(w)for a,w in checks.items()},
'4227088':{'input':'x0=input record; x1=start; x2=count/search position; x8=indirect caller result.',
'guard':'Reads input+8 uint64 length; unsigned length<start takes dynamic __throw_out_of_range_fmt branch.',
'normalTailMapping':{'at':'0x42270b4','target':'0x42faf7c','x0':'original x8 result pointer','x1':'original x0 input','x2':'original x1 start','x3':'original x2 count'},
'directStores':'Only prologue store to own stack; no direct input/result write in finite body.',
'boundary':'Tail callee0x42faf7c not inspected here; it receives input/result and remains explicit transformation/write boundary.'},
'4286d08':{'input':'Original x0 points to static address0x6ce9a1a in parent caller.',
'effects':'Reads one byte from original x0 and stores it in own stack; no writes through input. Restores stack and tail-B to ELF-bound strlen with original x0 unchanged.',
'return':'Ordinary return is strlen result through tail call, providing length-shaped integer used by caller to form end pointer.',
'boundary':'Dynamic strlen implementation not expanded; no result-buffer or global-object argument supplied.'},
'limits':'No native execution, global-first48 immutability claim, vendor algorithm naming or service-side semantic conclusion. Full finite bodies verified; forwarded pointer alias and tail transformation remain unproven.'},indent=2))
