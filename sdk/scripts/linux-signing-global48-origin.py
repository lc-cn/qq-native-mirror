#!/usr/bin/env python3
"""Pinned, read-only initializer slice; never loads the native module."""
import contextlib,io,runpy,struct,hashlib,json,bisect,re,subprocess,sys
with contextlib.redirect_stdout(io.StringIO()):
 e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction'];b=e['b'];rel=e['base']['relocations']
checks={0x42f93f0:0x91156129,0x42f9438:0xf8206949,0x42f94ac:0xaa1303e0,0x42f94b0:0xaa1403e1,0x42f94b4:0x97150d23,
0x42f9560:0x52800b00,0x42f9564:0x97150b8b,0x42f9568:0x90014c29,0x42f9570:0x913b4929,
0x42f9574:0xb9003408,0x42f957c:0xad400520,0x42f9580:0x3dc00922,0x42f9588:0xad000400,
0x42f958c:0x3d800802,0x42f9590:0x38048d3f,0x42f9594:0xf9470508,0x42f9598:0xa903fc09,
0x42f959c:0x3900c01f,0x42f95a0:0xf9000100,0x42f95a8:0xd65f03c0}
for pc,w in checks.items():assert ins(pc)==w,(hex(pc),hex(ins(pc)),hex(w))
assert rel[0x89dee08]==(1027,0x8a077f0)
assert rel[0x89dc900]==(1027,0x8a077f8)
i=bisect.bisect_left(e['starts'],0x42f9558)
assert e['starts'][i:i+2]==[0x42f9558,0x42f95ac]
def readva(a,n):
 for s in e['sections']:
  if s[1]!=8 and s[3]<=a and a+n<=s[3]+s[5]:return b[s[4]+a-s[3]:s[4]+a-s[3]+n]
 raise ValueError(hex(a))
source=readva(0x6c7ded2,48)
assert hashlib.sha256(source).hexdigest()=='f88007f6ee01e966ee287956f490dac8edc6bc53a54a13bdeb02a9730340248d'
i=bisect.bisect_left(e['starts'],0x42f9378)
assert e['starts'][i:i+2]==[0x42f9378,0x42f9558]
wrapperWords={pc:ins(pc) for pc in range(0x42f9378,0x42f9558,4)}
pltExpected={0x83c390:([0xb0040d30,0xf9400611,0x91002210,0xd61f0220],0x89e1008,'_Znwm'),
 0x83c940:([0xb0040d30,0xf9417211,0x910b8210,0xd61f0220],0x89e12e0,'pthread_once')}
def section(name):
 return next(x for x in e['sections'] if e['names'][x[0]:].split(b'\0',1)[0]==name)
sym=section(b'.dynsym');strings=section(b'.dynstr')
def bind(sectionName,got,kind,label):
 s=section(sectionName)
 rows=[(info,addend) for address,info,addend in struct.iter_unpack('<QQq',b[s[4]:s[4]+s[5]]) if address==got]
 assert len(rows)==1
 info,addend=rows[0];assert info&0xffffffff==kind
 idx=struct.unpack_from('<I',b,sym[4]+(info>>32)*24)[0]
 actual=b[strings[4]+idx:strings[4]+strings[5]].split(b'\0',1)[0].decode('ascii')
 assert actual==label,(hex(got),actual)
 return {'got':hex(got),'relocationType':kind,'symbol':actual,'addend':addend}
bindings=[]
for pc,(words,got,label) in pltExpected.items():
 assert [struct.unpack('<I',readva(pc+j*4,4))[0] for j in range(4)]==words
 bindings.append({'plt':hex(pc),'words':[hex(w) for w in words],**bind(b'.rela.plt',got,1026,label)})
bindings.append(bind(b'.rela.dyn',0x89debc8,1025,'__once_proxy'))
path=sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
# Independent system disassembler check covers the complete wrapper and both PLT stubs.
objdumpChecks=[]
for start,stop,expected in [(0x42f9378,0x42f9558,wrapperWords)]+[(pc,pc+16,{pc+j*4:w for j,w in enumerate(row[0])}) for pc,row in pltExpected.items()]:
 args=['/usr/bin/objdump','-d',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path]
 output=subprocess.check_output(args,text=True)
 observed={int(a,16):int(w,16) for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',output,re.M)}
 assert observed==expected,(hex(start),len(observed),len(expected))
 objdumpChecks.append({'command':args,'matchedInstructions':len(expected)})
print(json.dumps({'sha256':e['base']['expected'],'initializerRange':['0x42f9558','0x42f95ac'],
'wrapperRange':['0x42f9378','0x42f9558'],
'wrapperWords':[{'at':hex(pc),'word':hex(w)} for pc,w in wrapperWords.items()],
'objdumpChecks':objdumpChecks,'dynamicSymbolBindings':bindings,
'initializerWords':[{'at':hex(pc),'word':hex(ins(pc))} for pc in range(0x42f9558,0x42f95ac,4)],
'selectedWords':{hex(pc):hex(w) for pc,w in checks.items()},
'relocations':{'0x89dee08':'R_AARCH64_RELATIVE -> 0x8a077f0','0x89dc900':'R_AARCH64_RELATIVE -> 0x8a077f8'},
'static48':{'address':'0x6c7ded2','length':48,'hex':source.hex(),'sha256':hashlib.sha256(source).hexdigest()},
'proven':[
'Initializer allocates 0x58 bytes at 0x42f9564; copies static 48 bytes to allocation offsets 0..47 at 0x42f9588/958c.',
'Initializer writes uint32 -1 at allocation+0x34, byte zero at +0x30 and +0x48; stores allocation+0x48 and zero as pair at +0x38/+0x40.',
'0x42f95a0 stores allocation pointer through GOT 0x89dee08 into global 0x8a077f0.',
'0x42f9378 wrapper saves original x0 in x19, registers address 0x42f9558 via TLS slot, and passes original x0 plus GOT-loaded x20 to pthread_once at 0x42f94b4.',
'Nested-transform call site uses original x0 from GOT0x89dc900 resolving adjacent global0x8a077f8 before loading allocation through global0x8a077f0.'
],
'boundary':'Initializer construction proven; indirect pthread_once callback dispatch and all later pointee writes not exhaustively analyzed. Initial static48 is not proof of unchanged runtime48. No detector/algorithm/signature semantic assigned; no native execution.'},indent=2))
