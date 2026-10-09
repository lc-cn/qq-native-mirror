#!/usr/bin/env python3
"""Bounded static instruction evidence; never loads the native module."""
import contextlib, io, json, re, runpy, subprocess
with contextlib.redirect_stdout(io.StringIO()):
    env = runpy.run_path('scripts/linux-signing-provider-map.py')
path = env['base'].get('path')
# Existing pinned reader accepts the wrapper argument and verifies its full hash.
import sys
path = sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
out = subprocess.check_output(['/usr/bin/objdump','--disassemble','--start-address=0x4334048','--stop-address=0x433bf80',path],text=True)
rows=[]
for line in out.splitlines():
    m=re.match(r'\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.+)',line)
    if m:
        pc,word=int(m[1],16),int(m[2],16)
        if env['instruction'](pc)!=word: raise SystemExit('Disassembly word mismatch')
        rows.append((pc,m[3].split(' //')[0].strip()))
if [pc for pc,_ in rows] != list(range(0x4334048,0x433bf80,4)):
    raise SystemExit('Incomplete consumer disassembly')
slots={0x170,0x940,0x948,0x958,0x960,0x970,0x978,0x938,0x950,0x96c,0x9e8,0x798,0x28}
inventory=[]
for pc,text in rows:
    m=re.search(r'\[x19(?:, #0x([0-9a-f]+))?\]',text)
    if not m: continue
    offset=int(m[1] or '0',16)
    # Include both slots of pair loads/stores (including implicit second slot).
    offsets=[offset]
    if text.startswith(('stp','ldp')):
        offsets.append(offset+(8 if re.match(r'(?:stp|ldp)\s+x',text) else 4))
    if any(x in slots for x in offsets):inventory.append({'pc':hex(pc),'instruction':text,'frameSlots':[hex(x) for x in offsets]})
blocks={
 'entryInstructionPointer':[(0x4334070,0x4334074),(0x43340b8,0x43340ec)],
 'instructionState':[(0x433732c,0x4337344),(0x433a990,0x433a9a8)],
 'or8Lookup':[(0x4339460,0x4339478),(0x433a18c,0x433a1a4),(0x433a7e0,0x433a808),(0x433a950,0x433a96c)],
 'returnLookup':[(0x4339638,0x4339660),(0x43397b0,0x43397c4)],
 'recordAllocation':[(0x43352e0,0x4335308),(0x4334cd0,0x4334cf8),(0x433a1a8,0x433a1c0)],
 'copy':[(0x4336af8,0x4336b18),(0x4335194,0x43351c4)],
 'lengthAndRecordReturn':[(0x433b994,0x433b9c0),(0x433afe4,0x433aff8),(0x433abf0,0x433ac08),(0x433a514,0x433a528),(0x4339dfc,0x4339e14),(0x433bf44,0x433bf80)]}
edgeInstructions={name:[{'pc':hex(pc),'instruction':text} for pc,text in rows if any(start<=pc<stop for start,stop in ranges)] for name,ranges in blocks.items()}
print(json.dumps({'edgeInstructions':edgeInstructions,'sha256':env['base']['expected'],'bounds':['0x4334048','0x433bf80'],'instructionsChecked':len(rows),'inventory':inventory,
 'edges':{'record':'malloc16 -> frame940 -> frame948 -> frame148 -> frame170 -> framea00 -> x0',
 'data':'malloc(*(uint32*)frame950 << 2) -> frame958 -> *(R+8)',
 'length':'*(uint32*)frame950 -> frame96c -> *(uint32*)R',
 'copy':'*(frame938+8) -> frame978; uint32 indexed load(frame978,index) -> uint32 indexed store(*(R+8),index)',
 'sourceLookup':'frame938=lookup(owner, instructionByte1); frame6c8=lookup(owner,instructionByte1 & 15)',
 'or8':'frame798=frame6c8+8; frame7a0=*(frame798)+5; OR8 byte store via frame7a0'},
 'limits':'No proof of same lookup index across paths, same table entry, flag-dependent transformed copy, or complete obfuscated path feasibility. Pair instructions included; indirect aliases remain bounded uncertainty.'},indent=2))
