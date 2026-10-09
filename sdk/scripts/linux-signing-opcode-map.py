#!/usr/bin/env python3
"""Pinned ELF opcode jump-table evidence. No native/provider execution."""
import contextlib,io,json,runpy,struct,subprocess,sys,re,hashlib
with contextlib.redirect_stdout(io.StringIO()): e=runpy.run_path('scripts/linux-signing-provider-map.py')
path=sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
start,stop=0x4334048,0x433bf80
text=subprocess.check_output(['/usr/bin/objdump','--disassemble',f'--start-address={hex(start)}',f'--stop-address={hex(stop)}',path],text=True)
rows={}
for line in text.splitlines():
 m=re.match(r'\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.+)',line)
 if m:
  pc=int(m[1],16)
  if e['instruction'](pc)!=int(m[2],16):raise SystemExit('Instruction mismatch')
  rows[pc]=m[3].split(' //')[0].strip()
if list(rows)!=list(range(start,stop,4)):raise SystemExit('Incomplete consumer')
checks={0x4337340:0x39400109,0x433734c:0x373f91c9,0x4337350:0xf0014a2b,0x4337354:0x9116796b,0x4337358:0x10fe76c8,0x433735c:0x7869796a,0x4337360:0x8b0a0908,0x4337364:0xd61f0100}
for pc,word in checks.items():
 if e['instruction'](pc)!=word:raise SystemExit('Dispatcher changed')
table=0x6c7e59e
section=next(s for s in e['sections'] if s[1]!=8 and s[3]<=table and table+256<=s[3]+s[5])
offset=section[4]+table-section[3]
entries=[{'opcode':op,'tableValue':struct.unpack_from('<H',e['b'],offset+2*op)[0]} for op in range(128)]
for entry in entries:entry['destination']=hex(0x4334230+entry['tableValue']*4)
selected={0x61:'0x4336e1c',0x62:'0x4339638',0x79:'0x4339460',0x7a:'0x4336d00'}
if any(entries[op]['destination']!=target for op,target in selected.items()):raise SystemExit('Unexpected selected opcode destination')
with contextlib.redirect_stdout(io.StringIO()): source=runpy.run_path('scripts/linux-signing-instruction-source.py')
blob=source['blob']
if 0x62 in blob:raise SystemExit('Unexpected opcode62 byte in pinned static blob')
candidates={hex(op):[i for i,v in enumerate(blob) if i>=16 and v==op] for op in selected}
regions={'returnByteCopyEntry':(0x4336e1c,0x4336e34),'returnByteOperand':(0x433bc80,0x433bc98),'returnByteLookup':(0x433bc18,0x433bc50),'returnByteRecordAllocation':(0x4336724,0x4336764),'returnByteDataAllocation':(0x4334ba8,0x4334be4),'returnByteDataStore':(0x4339a54,0x4339a78),'returnByteCopy':(0x433a164,0x433a18c),'returnByteCopyAndResult':(0x4338744,0x433878c),'returnByteResultPropagation':(0x43349e4,0x4334a00),'returnByteResultDispatch':(0x43340ec,0x43340f4),'returnByteResultSlot':(0x43384e0,0x43384f4),'returnByteDataAddress':(0x4334bdc,0x4334be4),'opcode7aEntry':(0x4336d00,0x4336d6c),'opcode7aHelper':(0x433a9c8,0x433a9fc),'dispatch':(0x433732c,0x4337368),'or8Entry':(0x4339460,0x43394b0),'copyEntry':(0x4339638,0x4339664),'advanceSixCandidate':(0x4339b18,0x4339b38),'loadAdvanceSix':(0x433b974,0x433b988)}
print(json.dumps({'sha256':e['base']['expected'],'instructionsChecked':len(rows),'tableVA':hex(table),'tableFileOffset':hex(offset),'tableSha256':hashlib.sha256(e['b'][offset:offset+256]).hexdigest(),'entries':entries,'staticBlobCandidates':{'sha256':source['digest'],'byteOffsets':candidates,'limits':'Raw byte positions only, not decoded instruction boundaries. No 0x62 byte occurs anywhere in the pinned blob; this cannot exclude other instruction sources or runtime changes.'},'regions':{name:[{'pc':hex(pc),'instruction':ins} for pc,ins in rows.items() if low<=pc<high] for name,(low,high) in regions.items()},'confirmed':'Byte0 bit7 exits; other opcodes index uint16 table. 0x79 enters OR8 lookup, 0x62 enters returned-record copy lookup. Both load operand byte1 from current instruction state.','unresolved':'Instruction lengths for these two cases, conditional paths through flattened state dispatcher, and actual program instruction boundaries/order are not established. Advance-six region is evidence candidate only, not assigned to either opcode. Opcode 0x61 maps to 0x4336e1c and has a separate byte-copy record path; opcode 0x7a maps to 0x4336d00 and invokes helper 0x434c4c0 via saved lookup object, semantics unknown. No table-entry identity or copy coverage proof.'},indent=2))
