#!/usr/bin/env python3
"""Two pinned finite callees: static instruction and dynamic-symbol proof only."""
import contextlib,io,runpy,struct,json,bisect,subprocess,re,sys,hashlib
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
b=e['b'];ins=e['instruction'];path=sys.argv[1] if len(sys.argv)>1 else '.local/research/linux-arm64/opt/QQ/resources/app/wrapper.node'
def sec(name):return next(s for s in e['sections'] if e['names'][s[0]:].split(b'\0',1)[0]==name)
def word(a):
 for s in e['sections']:
  if s[1]!=8 and s[3]<=a and a+4<=s[3]+s[5]:return struct.unpack_from('<I',b,s[4]+a-s[3])[0]
 raise ValueError(hex(a))
sym=sec(b'.dynsym');strings=sec(b'.dynstr');rel=sec(b'.rela.plt');plt=sec(b'.plt')
rels={a:i for a,i,_ in struct.iter_unpack('<QQq',b[rel[4]:rel[4]+rel[5]])}
def label(target):
 if not plt[3]<=target<plt[3]+plt[5]:return None
 adrp,ldr,add,br=[word(target+i*4) for i in range(4)]
 assert adrp&0x9f00001f==0x90000010 and ldr&0xffc003ff==0xf9400211 and br==0xd61f0220
 n=((adrp>>29)&3)|(((adrp>>5)&0x7ffff)<<2)
 if n&0x100000:n-=0x200000
 got=(target&~4095)+(n<<12)+((ldr>>10)&4095)*8
 info=rels[got];assert info&0xffffffff==1026
 idx=struct.unpack_from('<I',b,sym[4]+(info>>32)*24)[0]
 name=b[strings[4]+idx:strings[4]+strings[5]].split(b'\0',1)[0].decode('ascii')
 return {'got':hex(got),'symbol':name,'relocationType':1026,'pltWords':[hex(x) for x in [adrp,ldr,add,br]]}
checks={0x434e7a4:0xaa0103f3,0x434e7a8:0xaa0003f4,0x434e7b0:0x9100e00a,0x434e7e8:0xf9400508,
0x434e7f8:0x910023e8,0x434e7fc:0xaa1403e0,0x434e800:0xaa1303e1,0x434e804:0x94000096,
0x434e808:0xf94003e0,0x434e80c:0x910023e1,0x434e810:0x97fb622f,
0x434e874:0xd10033a8,0x434e8a4:0x53187c70,0x434e8a8:0x53107c72,0x434e8d4:0x53087c6f,
0x434e8d8:0x381f43b0,0x434e90c:0x381f63af,0x434e914:0x381f73a3,0x434e918:0x381f53b2,
0x434e94c:0x6b02023f,0x434e95c:0x38706831,0x434e978:0x3872c912,0x434e97c:0x4a110251,0x434e980:0x38306831,0x434e990:0x11000610}
for pc,w in checks.items():assert ins(pc)==w,(hex(pc),hex(ins(pc)))
rows=[]
for start,stop in [(0x434e76c,0x434e864),(0x434e864,0x434e9c4)]:
 i=bisect.bisect_left(e['starts'],start);assert e['starts'][i:i+2]==[start,stop]
 args=['/usr/bin/objdump','-d',f'--start-address={start:#x}',f'--stop-address={stop:#x}',path]
 out=subprocess.check_output(args,text=True)
 observed={int(a,16):int(w,16) for a,w in re.findall(r'^\s*([0-9a-f]+):\s+([0-9a-f]{8})\s',out,re.M)}
 words={pc:ins(pc) for pc in range(start,stop,4)};assert observed==words
 calls=[]
 for pc,w in words.items():
  if w&0xfc000000==0x94000000:
   n=w&0x3ffffff
   if n&0x2000000:n-=0x4000000
   target=pc+n*4;calls.append({'at':hex(pc),'target':hex(target),'dynamicBinding':label(target)})
 rows.append({'range':[hex(start),hex(stop)],'words':[{'at':hex(pc),'word':hex(w)} for pc,w in words.items()],
 'objdumpCommand':args,'matchedInstructions':len(words),'instructionSha256':hashlib.sha256(b''.join(struct.pack('<I',w) for w in words.values())).hexdigest(),'calls':calls})
print(json.dumps({'sha256':e['base']['expected'],'functions':rows,'selectedExactWords':{hex(a):hex(w) for a,w in checks.items()},
'first':{'input':'Original x0 saved x20; original x1 saved x19; object+0x38 stored sp+0.',
'guard':'Loads uint64 object+0x40 and flattened condition selects call path if zero.',
'calls':['0x434ea5c receives original object x0, original x1 and indirect result x8=&local(sp+8); not followed.',
'0x42270cc receives x0=object+0x38,x1=&local; not followed.',
'Local string-shaped pointer is conditionally passed to dynamic _ZdlPv.'],
'directWrites':'No direct store to original object in this body; writes target stack locals. Nested 0x434ea5c receives original object and may modify it; no immutability conclusion.'},
'second':{'input':'Original x0 is not used as object pointer: w0 becomes arithmetic scratch; x1 remains buffer pointer, w2 signed loop bound, w3 supplies four byte masks.',
'localMask':'Stack local bytes x29-0xc..-0x9 are filled from w3 bits24,16,8,0 in that order.',
'bufferEffect':'Indexed input byte at x1+signedindex is XORed with local mask[index modulo4] and stored back at x1+signedindex; signedindex starts0 and increments while signedindex<w2. Caller supplies496.',
'directWrites':'Only non-stack direct store is STRB [x1,x16] at0x434e980. No direct writes through original x0 or first48 in this body; x1 alias with object not ruled out across caller.',
'calls':'Only stack-check-failure PLT call; no processing callee expansion.'},
'boundary':'Static bodies only, no native execution. First callee nested functions not inspected. Branch/runtime reachability and cross-caller input-buffer alias remain unproven. No algorithm/detector/signature semantics assigned.'},indent=2))
