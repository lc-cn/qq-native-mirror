#!/usr/bin/env python3
"""One pinned transform body, exact disassembly inventory; never executes ELF."""
import contextlib,io,runpy,json,re,subprocess,sys,bisect
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
with contextlib.redirect_stdout(io.StringIO()):
 # Independently validates stack-check PLT against .rela.plt/.dynsym bytes.
 pltEvidence=runpy.run_path('scripts/linux-signing-setup-callees.py')['pltSymbols']
start,stop=0x434c4c0,0x434d2e0
i=bisect.bisect_left(e['starts'],start);assert e['starts'][i:i+2]==[start,stop]
path=sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
out=subprocess.check_output(['/usr/bin/objdump','--disassemble',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path],text=True)
rows=[];calls=[];returns=[]
for line in out.splitlines():
 m=re.match(r'\s*([0-9a-f]+):\s+([0-9a-f]{8})\s+(.+)',line)
 if not m:continue
 pc,w=int(m[1],16),int(m[2],16);assert e['instruction'](pc)==w
 text=m[3].split(' //')[0].strip();rows.append({'pc':hex(pc),'word':hex(w),'instruction':text})
 if w&0xfc000000==0x94000000:calls.append(rows[-1])
 if w&0xfffffc1f==0xd65f0000:returns.append(hex(pc))
assert [int(row['pc'],16) for row in rows]==list(range(start,stop,4)), 'Incomplete transform disassembly'
assert len(calls)==5 and returns==['0x434d2d8']
print(json.dumps({'sha256':e['base']['expected'],'range':[hex(start),hex(stop)],'allInstructions':rows,'directCalls':calls,'returns':returns,
 'verifiedExternalPlt':[p for p in pltEvidence if p['plt']=='0x83d540'],
 'inputEdges':['original w2 saved sp+0x14','original x0 saved sp+8','original x0+8 saved sp+0x28; pointer loaded at 434c560',
 '434cca8/cb0 retains original x0 at sp+0x48; 434ccb8 loads its uint32 length',
 '434cca0/cac loads original object data at +8; 434cdbc reads indexed byte from that data register x9 and 434cdcc writes indexed byte to x11 from local sp+0x40'],
 'returnEdge':'normal x0 loaded from sp+0x18 at 434d2d0; writes to that slot at 434c8ec (null) and 434cfa0 (sp+0x20)',
 '加工Call':'434d0d4 -> 4356f94 has x0=local sp40+2, w1=original object uint32 length+8. Callee body and semantic name not inspected.',
 'limits':'Direct calls: 424a894 twice,435711c,4356f94,stack_chk_fail PLT. No memcpy PLT in body. Complete allocation/output-record alias, local sp40 initialization, reachable flattened paths and OR8-byte propagation remain unresolved. No crypto/detection semantic inference.'},indent=2))
