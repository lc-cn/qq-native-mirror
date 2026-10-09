#!/usr/bin/env python3
"""Two finite helper bodies from the pinned ELF; no native execution."""
import bisect, contextlib, io, json, runpy, struct
with contextlib.redirect_stdout(io.StringIO()):
    e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction']
ranges=[(0x434d384,0x434daa4),(0x434daa4,0x434dc44)]
checks={0x434d3a4:0x91006008,0x434d3bc:0xa900a3e0,
 0x434d3d0:0xaa0103f3,0x434d3dc:0xf9400108,0x434d3ec:0x38616909,
 0x434d660:0x2a1f03e1,0x434d724:0x2a1f03e1,0x434d874:0x2a1f03e1,
 0x434d7e0:0xf900011f,0x434da78:0x2a1f03e0,0x434da80:0x52800020,
 0x434dac8:0xaa0203f3,0x434dae4:0x91008008,0x434dae8:0xf81f03a1,
 0x434daf8:0xf9400100,0x434db00:0xf9400501,0x434db04:0x940000a7,
 0x434db94:0xf85e83a9,0x434db98:0xf9400108,0x434db9c:0xcb080128,
 0x434dba0:0x9343fd09,0x434dbac:0xf9000269,
 0x434dbbc:0xa9402508,0x434dbc0:0xcb080128,0x434dbc4:0x9343fd08,
 0x434dbc8:0xf9000268,0x434dbcc:0xf94007e0,0x434dbd0:0x9713b224}
for pc,w in checks.items():
    if ins(pc)!=w:raise SystemExit(f'Instruction mismatch {pc:#x}')
names={0x83a5f0:'memset@plt',0x83c7b0:'free@plt',0x83d540:'__stack_chk_fail@plt',
       0x83a460:'std::vector<long>::emplace_back<long&>@plt'}
# Independently bind PLT labels to dynamic relocation/symbol bytes in this ELF.
b=e['b'];sections=e['sections'];sectionNames=e['names']
def section(name):
    return next(x for x in sections if sectionNames[x[0]:].split(b'\0',1)[0]==name)
rel=section(b'.rela.plt');sym=section(b'.dynsym');strings=section(b'.dynstr')
assert rel[9]==24 and sym[9]==24
relocations={address:info for address,info,addend in struct.iter_unpack('<QQq',b[rel[4]:rel[4]+rel[5]])}
expectedLabels={0x83a460:(0x89e0070,'_ZNSt6vectorIlSaIlEE12emplace_backIJRlEEES3_DpOT_'),
    0x83a5f0:(0x89e0138,'memset'),0x83c7b0:(0x89e1218,'free'),0x83d540:(0x89e18e0,'__stack_chk_fail')}
pltSymbols=[]
for address,(got,expectedLabel) in expectedLabels.items():
    info=relocations[got];symbolIndex=info>>32
    assert symbolIndex*24+24<=sym[5]
    stringIndex=struct.unpack_from('<I',b,sym[4]+symbolIndex*24)[0]
    assert stringIndex<strings[5]
    label=b[strings[4]+stringIndex:strings[4]+strings[5]].split(b'\0',1)[0].decode('ascii')
    if label!=expectedLabel:raise SystemExit(f'PLT dynamic symbol mismatch {address:#x}')
    pltSymbols.append({'plt':hex(address),'gotRelocation':hex(got),'dynamicSymbol':label})
rows=[]
for start,stop in ranges:
    i=bisect.bisect_left(e['starts'],start)
    assert e['starts'][i:i+2]==[start,stop], 'Unwind range mismatch'
    calls=[];returns=[];indirect=[]
    for pc in range(start,stop,4):
        w=ins(pc)
        if w&0xfc000000==0x94000000:
            n=w&0x3ffffff
            if n&0x2000000:n-=0x4000000
            target=pc+n*4
            calls.append({'at':hex(pc),'word':hex(w),'target':hex(target),'name':names.get(target)})
        if w&0xfffffc1f==0xd65f0000:returns.append(hex(pc))
        if w&0xfffffc1f in (0xd61f0000,0xd63f0000):indirect.append(hex(pc))
    rows.append({'range':[hex(start),hex(stop)],'calls':calls,'returns':returns,'indirectBranches':indirect})
print(json.dumps({'sha256':e['base']['expected'],'functions':rows,
 'selectedExactWords':{hex(a):hex(w)for a,w in checks.items()},'verifiedPltSymbols':pltSymbols,
 'firstContract':{'input':'owner x0 at sp+8, x1 in x19 as index; reads byte through owner+0x18 plus index at 0x434d3ec',
  'effects':'Three memset calls explicitly use zero fill, four free calls, and a pointed 8-byte zero store at 0x434d7e0. Path-dependent local pointer aliases/lengths not fully recovered.',
  'return':'Both explicit normal epilogue routes set w0 to 0 or 1; flag meaning unknown'},
 'secondContract':{'ownerRegion':'original owner+0x20 retained at sp+8; input x1 retained x29-0x10; output pointer x2 retained x19',
  'searchCall':'0x434dda0 receives two pointers loaded from owner+0x20/+0x28 and &local(input x1); not followed',
  'outputWrites':[{'at':'0x434dbac','value':'(local returned position - *(owner+0x20)) arithmetic-shift-right 3'},
                  {'at':'0x434dbc8','value':'(*(owner+0x28) - *(owner+0x20)) arithmetic-shift-right 3'}],
  'append':'0x434dbd0 invokes named std::vector<long>::emplace_back<long&> on owner+0x20 with address of stored input x1',
  'inference':'Owner+0x20 is a long-vector-shaped region. Caller local output is an index/count-shaped 8-byte value, not proven payload pointer.',
  'return':'No assigned explicit final x0 return contract; useful result stored through original x2'},
 'boundary':'No proven OR8 target alias, provider-output propagation, vendor class schema or server marker. Only these two bodies inspected; no native execution or nested callee expansion.'},indent=2))
