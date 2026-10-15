#!/usr/bin/env python3
"""Read-only checks for a narrowly identified flattened-state write path."""
import contextlib,io,runpy,json
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
checks={0x4335ac8:0x7100051f,0x433bda8:0x1a880129,0x4334a60:0x5402b960,0x433a19c:0x91002108,0x433a1a0:0xf903ce68,0x43361b4:0x54023160,0x433a7f0:0xf9400108,0x433a7f4:0x91001508,0x433a800:0x39400108,0x4336280:0x54023680,0x433a964:0x321d0108,0x433a968:0x39000148,0x433652c:0x5401af60,0x4339470:0x97ffe0bc,0x4339474:0xf9036660}
for a,w in checks.items():
 if e['instruction'](a)!=w:raise SystemExit(f'Instruction mismatch {hex(a)}')
print(json.dumps({'sha256':e['base']['expected'],'equalOnePath':[
 {'state':'0x04bf8aad','dispatch':'0x4334a60','block':'0x433a18c','effect':'frame+0x798 = [frame+0x6c8] + 8'},
 {'state':'0x2137f5ae','dispatch':'0x43361b4','block':'0x433a7e0','effect':'P = [[frame+0x798]] + 5; byte = *P'},
 {'state':'0x0a12e4fc','dispatch':'0x4336280','block':'0x433a950','effect':'*P = byte OR 0x08'},
 {'state':'0xd990ab20','dispatch':'0x433652c','block':'0x4339b18','effect':'common continuation'}],
 'notEqualOnePath':[{'state':'0xd990ab20','block':'0x4339b18','effect':'skips the identified OR-write sequence'}],
 'pointerOrigin':{'call':'0x4339470','helper':'0x4331760','savedReturn':'0x4339474 to frame+0x6c8'},
 'limits':'Static local state effects only. Mapping this pointed byte to final provider output or protocol semantics remains unproven; no native execution.'},indent=2))
