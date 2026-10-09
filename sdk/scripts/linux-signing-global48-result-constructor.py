#!/usr/bin/env python3
"""Single unwind-bounded static result-construction edge; no native execution."""
import contextlib,io,runpy,json,struct,bisect,subprocess,re,hashlib
with contextlib.redirect_stdout(io.StringIO()):m=runpy.run_path('scripts/linux-signing-global48-mutators.py')
e=m['e'];ins=e['instruction'];label=m['label'];path=m['path'];start=0x42faf7c;stop=0x42fafcc
idx=bisect.bisect_left(e['starts'],start);assert e['starts'][idx:idx+2]==[start,stop]
expected=[0xa9bf7bfd,0x910003fd,0xf9400428,0x9100400a,0xeb020109,0xf900000a,0x54000103,0xf9400028,0xeb03013f,0x8b020101,0x9a898068,0x8b080022,0xa8c17bfd,0x1715000c,0xf0014c00,0xf0014c01,0x91119c00,0x911ca421,0xaa0803e3,0x97150512]
words={start+4*j:ins(start+4*j)for j in range(len(expected))};assert list(words.values())==expected
args=['/usr/bin/objdump','-d',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path]
out=subprocess.check_output(args,text=True)
observed={int(a,16):int(w,16)for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',out,re.M)};assert observed==words
branches=[]
for pc,w in words.items():
 if w&0x7c000000==0x14000000:
  n=w&0x3ffffff
  if n&0x2000000:n-=0x4000000
  t=pc+4*n;branches.append({'at':hex(pc),'target':hex(t),'kind':'BL'if w&0x80000000 else 'tail-B','dynamicBinding':label(t)})
print(json.dumps({'sha256':e['base']['expected'],'range':[hex(start),hex(stop)],'instructionCount':20,
'words':[{'at':hex(a),'word':hex(w)}for a,w in words.items()],
'instructionSha256':hashlib.sha256(b''.join(struct.pack('<I',w)for w in words.values())).hexdigest(),'objdumpCommand':args,'externalBranches':branches,
'callerMapping':{'x0':'caller indirect-result pointer (stack local)','x1':'input record','x2':'start offset (0 in analyzed caller)','x3':'count (backwards-search position in analyzed caller)'},
'facts':['Loads input uint64 length at input+8. Writes result+0 = result+0x10 before bounds branch.',
'Unsigned length<start takes ELF-bound __throw_out_of_range_fmt. Otherwise input data is loaded from input+0.',
'Normal branch computes begin=input.data+start; length=min(input.length-start,count) using unsigned comparison; end=begin+length.',
'Tail-B 0x42fafb0 to ELF-bound basic_string::_M_construct<const char*> receives x0=result, x1=begin, x2=end.',
'Only direct non-stack store in this body writes result+0; input record and input data are only read. No memcpy or direct input data write in finite body.'],
'boundary':'Named dynamic libstdc++ constructor implementation not expanded; its result/buffer writes are delegated. Cross-caller pointer aliases and complete runtime provenance not proven. No global-first48 immutability, algorithm/authenticity or server-side semantic claim; no native execution.'},indent=2))
