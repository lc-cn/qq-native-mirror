#!/usr/bin/env python3
"""Pinned finite follow-up bodies, no native execution or nested body expansion."""
import contextlib,io,runpy,json,bisect,struct,hashlib,subprocess,re
with contextlib.redirect_stdout(io.StringIO()):m=runpy.run_path('scripts/linux-signing-global48-mutators.py')
e=m['e'];ins=e['instruction'];label=m['label'];path=m['path']
checks={0x434ea80:0xaa0103f3,0x434ea84:0xaa0803f4,0x434ea94:0xf9400429,0x434eab0:0x7100bd5f,
0x434eac0:0x91004288,0x434eb6c:0xaa1403e8,0x434eb70:0xaa1303e0,0x434eb74:0xaa1f03e1,
0x434eb78:0x97fb6144,0x434eb94:0xf9000288,0x434eba0:0xaa1403e0,0x434eba8:0x9713b10e,
0x42270dc:0xaa0103f3,0x42270e0:0xaa0003f4,0x4227104:0xa9002a81,0x4227110:0xf9000a8b,
0x422712c:0xf9400280,0x422713c:0x39000008,0x4227148:0xa9002681,0x4227150:0xf9000a89,
0x4227160:0x97184d68,0x422716c:0xf9000688,0x4227170:0x3828693f}
for pc,w in checks.items():assert ins(pc)==w,(hex(pc),hex(ins(pc)))
rows=[]
for start,stop in [(0x434ea5c,0x434ec08),(0x42270cc,0x4227190)]:
 i=bisect.bisect_left(e['starts'],start);assert e['starts'][i:i+2]==[start,stop]
 words={pc:ins(pc) for pc in range(start,stop,4)}
 args=['/usr/bin/objdump','-d',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path]
 out=subprocess.check_output(args,text=True)
 observed={int(a,16):int(w,16) for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',out,re.M)}
 assert observed==words
 calls=[]
 for pc,w in words.items():
  if w&0xfc000000==0x94000000:
   n=w&0x3ffffff
   if n&0x2000000:n-=0x4000000
   t=pc+n*4;calls.append({'at':hex(pc),'target':hex(t),'dynamicBinding':label(t)})
 rows.append({'range':[hex(start),hex(stop)],'words':[{'at':hex(pc),'word':hex(w)}for pc,w in words.items()],
 'objdumpCommand':args,'matchedInstructions':len(words),'instructionSha256':hashlib.sha256(b''.join(struct.pack('<I',w)for w in words.values())).hexdigest(),'calls':calls})
print(json.dumps({'sha256':e['base']['expected'],'functions':rows,'selectedExactWords':{hex(a):hex(w)for a,w in checks.items()},
'434ea5c':{'registerProvenance':'Original x1 saved x19, original indirect result x8 saved x20. Original x0 is not read as a pointer before being overwritten by call argument preparation.',
'inputReads':'Reads input+8 length and input+0 data; backwards byte search compares byte with0x2f. No semantic label assigned to input.',
'output':'Writes indirect result (caller stack local), with result+0x10 inline storage pointer; calls named basic_string::_M_construct<const char*> on result. Alternative branch calls0x4227088 with x0=input,x1=0,x2=search position,x8=result.',
'nestedBoundaries':['0x4227088 input/result operation not followed.','0x4286d08 receives static address0x6ce9a1a, ordinary x0 subsequently forms end pointer; not followed.'],
'objectEffect':'No direct memory access through original global-object x0 and no original-object pointer forwarded to its direct callees. Does not independently prove inputs/results nonaliasing.'},
'42270cc':{'input':'Original x0 destination retained x20; original x1 source retained x19. Caller destination is globalObject+0x38 and source=&local.',
'directDestinationStores':['0x4227104/7148 destination+0/+8 -> globalObject+0x38/+0x40.','0x4227110/7150 destination+0x10 -> globalObject+0x48.','0x422716c destination+8 -> globalObject+0x40.'],
'bufferStores':'Local-storage branch loads *destination and writes source bytes there (one-byte store or dynamic memcpy), then terminator. Other branches move/swap data pointers and capacity-shaped values and clear source length/firstbyte.',
'first48':'No direct store to globalObject offsets0..47. Indirect *destination or *source stores cannot be globally excluded from aliasing first48 without buffer-pointer/control-flow provenance. Initializer sets destination data pointer to globalObject+0x48 but this alone is not whole-runtime invariance.',
'nestedBoundaries':'Only direct call is ELF-bound memcpy; no additional internal callee in this finite body.'},
'boundary':'Only these two unwind-bounded bodies inspected. No whole-program immutability proof, runtime branch observation, algorithm/detector semantic or native execution.'},indent=2))
