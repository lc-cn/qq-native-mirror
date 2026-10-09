#!/usr/bin/env python3
"""Bounded ADRP/LDR references and local instruction windows, never native execution."""
import contextlib,io,runpy,struct,json,bisect,hashlib,subprocess,re,sys
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
b=e['b'];ins=e['instruction'];s=e['text'];target=0x89dee08
assert e['base']['relocations'][target]==(1027,0x8a077f0)
refs=[]
# Limited syntactic def-use: ADRP plus up to 6 following instructions, no calls or branches.
# This is not a full register-write decoder: conservatively stop on any low-Rd match.
for pc in range(s[3],s[3]+s[5],4):
 w=ins(pc)
 if w&0x9f000000!=0x90000000:continue
 rd=w&31;imm=((w>>29)&3)|(((w>>5)&0x7ffff)<<2)
 if imm&(1<<20):imm-=1<<21
 page=(pc&~4095)+(imm<<12)
 if page!=target&~4095:continue
 for q in range(pc+4,min(pc+28,s[3]+s[5]),4):
  z=ins(q)
  if z&0xffc00000==0xf9400000 and (z>>5)&31==rd and page+((z>>10)&4095)*8==target:
   refs.append({'adrp':hex(pc),'load':hex(q),'words':[{'at':hex(a),'word':hex(ins(a))} for a in range(pc,min(q+84,s[3]+s[5]),4)]});break
  if z&0x7c000000==0x14000000 or z&0xff000010==0x54000000 or z&31==rd:break
expected=[0x4265d1c,0x43325dc,0x433642c,0x4338188,0x43394c8,0x4356ec0,0x4888c2c]
assert sorted(int(x['load'],16) for x in refs)==sorted(expected), [x['load'] for x in refs]
checks={0x43325e0:0xf9400100,0x43325e4:0x9400000c,0x433643c:0xf9400100,0x4336440:0x97fff075,
 0x4332644:0x9100d009,0x43326a0:0xa902a260,0x43326a4:0x9100c008,0x43326b8:0xa900a668,
 0x4332ad4:0xf9401660,0x4332ad8:0x94006f25,0x43336bc:0xf9401660,0x43336d0:0x94006c65,
 0x4333fd0:0xf9400668,0x4333fdc:0xf9005668,0x4333774:0xf9405668,0x4333784:0xf9005a68,0x4333788:0xf9405a68,0x433377c:0x39000109,0x4333780:0xf9400a68,0x433378c:0xb900011f}
for pc,w in checks.items():assert ins(pc)==w,(hex(pc),hex(ins(pc)))
i=bisect.bisect_left(e['starts'],0x4332614);assert e['starts'][i:i+2]==[0x4332614,0x4334048]
path=sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
args=['/usr/bin/objdump','-d','--start-address=0x4332614','--stop-address=0x4334048',path]
out=subprocess.check_output(args,text=True)
observed={int(a,16):int(w,16) for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',out,re.M)}
assert observed=={pc:ins(pc) for pc in range(0x4332614,0x4334048,4)}
print(json.dumps({'sha256':e['base']['expected'],'scan':{'section':'.text','range':[hex(s[3]),hex(s[3]+s[5])],'maxFollowingInstructions':6,'method':'ADRP + immediate uint64 LDR with same base; conservatively terminates on low-Rd match or selected branch encodings','references':refs},
'callee':{'range':['0x4332614','0x4334048'],'objdumpCommand':args,'matchedInstructions':len(observed),'instructionsSha256':hashlib.sha256(b''.join(struct.pack('<I',observed[a]) for a in sorted(observed))).hexdigest(),
'facts':['Global object is passed unchanged as x0 at 0x43325e4 and 0x4336440 to 0x4332614.',
'Entry saves original x0 to frame+0x28; original x0+0x30/+0x34 to frame+0x8/+0x10.',
'Original pointer is reloaded from frame+0x28 and passed to nested callees 0x434e76c at 0x4332ad8 and 0x434e864 at 0x43336d0; their bodies are not followed.',
'0x433377c stores byte one through alias of object+0x30, 0x433378c stores uint32 zero through alias of object+0x34; both lie beyond first48 bytes. Cross-flattened-block reachability not proven.'],
'selectedExactWords':{hex(a):hex(w) for a,w in checks.items()}},
'conclusion':'No first48 write has been established by the bounded local reference windows. Two pointer-passing nested callees remain concrete potential writers, so immutability or ordering before nested construction cannot be concluded.',
'limitations':['Known initializer reference 0x42f9578->0x42f9594 spans seven following instructions and is deliberately outside the six-instruction scan; independently verified in global48-origin.py.','Only ADRP plus nearby immediate LDR pattern is searched; aliases, longer sequences, direct global address materialization, register-offset accesses and indirect calls can be missed.','Reference windows do not provide whole-program or control-flow-sensitive alias analysis.','Only 0x4332614 entry field provenance and selected reload/store sites inspected; nested callee bodies are excluded.','No detector/algorithm/output semantics assigned; no native execution.']},indent=2))
