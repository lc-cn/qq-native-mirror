#!/usr/bin/env python3
"""Finite return-object conversion chain; no ELF execution."""
import contextlib,io,json,runpy,bisect,struct
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction']
checks={0x426281c:0xaa0403f3,0x4262880:0x9108026b,0x42628b4:0xa900afea,
 0x4262b84:0xd10203a8,0x4262b8c:0x97ffa5f1,
 0x4262bc8:0xa9786fa1,0x4262bcc:0xf9400be0,0x4262bd0:0xaa1b03e2,
 0x4262bd4:0x97175ecb,
 0x424c374:0xaa0803f4,0x424c3d8:0xa90a8274,0x424c450:0xf9005268,
 0x4257888:0xa9748ba1,0x425788c:0xd101c3a0,0x4257894:0xa9529263,
 0x4257898:0x940363c8,0x42578ac:0xf9007660,
 0x4330974:0xf94013e0,0x4330984:0x97fffdc2,0x433098c:0xaa0003fc,
 0x4330a70:0xaa1c03e0,0x433015c:0xaa0003f3,0x4330180:0xaa1303e0,
 0x4257794:0xf9407668,0x4257798:0x91002108,0x42577a4:0xf9400108,
 0x42577a8:0xf9007e68,0x4257828:0xf9407668,0x4257834:0xf9008268,
 0x425783c:0xb9400108,0x4257840:0xb9011668,
 0x4257630:0xb9411668,0x4257634:0xf9407e61,0x4257638:0x8b080022,
 0x425763c:0xa94a0268,0x4257640:0xf9000008,0x4257644:0x97178e67,
 0x4257754:0xf9407660,0x4257758:0x97179416}
for a,w in checks.items():
 if ins(a)!=w:raise SystemExit(f'Instruction mismatch {a:#x}')
b=e['b'];ss=e['sections'];ns=e['names']
def sec(name):return next(s for s in ss if ns[s[0]:].split(b'\0',1)[0]==name)
r=sec(b'.rela.plt');s=sec(b'.dynsym');d=sec(b'.dynstr')
rels={a:i for a,i,_ in struct.iter_unpack('<QQq',b[r[4]:r[4]+r[5]])}
# PLT 0x83afe0 loads GOT 0x89e0630; bind to the actual dynamic symbol.
word=ins(0x83afe4);got=0x89e0000+((word>>10)&0xfff)*8
index=rels[got]>>32;n=struct.unpack_from('<I',b,s[4]+index*24)[0]
label=b[d[4]+n:d[4]+d[5]].split(b'\0',1)[0].decode()
assert label=='_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE12_M_constructIPKcEEvT_S8_St20forward_iterator_tag'
memcpyLoad=ins(0x83a704)
memcpyGot=0x89e0000+((memcpyLoad>>10)&0xfff)*8
mi=rels[memcpyGot]>>32;mn=struct.unpack_from('<I',b,s[4]+mi*24)[0]
memcpyLabel=b[d[4]+mn:d[4]+d[5]].split(b'\0',1)[0].decode()
assert memcpyLabel=='memcpy'
ranges=[]
for a in [0x424c350,0x43307b8,0x433008c]:
 i=bisect.bisect_left(e['starts'],a);assert e['starts'][i]==a
 ranges.append([hex(a),hex(e['starts'][i+1])])
print(json.dumps({'sha256':e['base']['expected'],'ranges':ranges,
 'exactWords':{hex(a):hex(w)for a,w in checks.items()},'constructionSymbol':{'plt':'0x83afe0','got':hex(got),'symbol':label},
 'providerResultEdge':{'call':'0x4262b8c -> 0x424c350',
  'x8':'x29-0x80 at 0x4262b84',
  'stringDataLength':'ldp x1,x27 from x29-0x80 at 0x4262bc8; x2=x27 at 0x4262bd0',
  'destination':'original provider x4 retained x19; x19+0x200 saved sp+0x10 by pair at 0x42628b4; loaded x0 at 0x4262bcc',
  'copy':'0x4262bd4 BL 0x83a700',
  'dynamicSymbol':memcpyLabel,'got':hex(memcpyGot)},
 'returnEdges':[
  '4334048 ordinary x0 -> 433008c x19 -> ordinary x0 (known bounded caller)',
  '433008c ordinary x0 -> 43307b8 x28 at 433098c -> ordinary x0 at 4330a70',
  '43307b8 ordinary x0 -> 424c350 frame x19+0xe8 at 42578ac'],
 'resultObjectConversion':{'returnedObject':'R = frame[x19+0xe8]',
  'data':'*(uint64_t*)(R+8) -> frame[x19+0xf8] at 42577a4/77a8',
  'length':'*(uint32_t*)R -> frame[x19+0x114] at 425783c/7840',
  'destination':'saved original x8 indirect-result object, frame[x19+0xa8]',
  'construction':'x0=destination, x1=data, x2=data+zeroExtendedLength; invokes actual std::__cxx11::basic_string::_M_construct<const char*> at 4257644',
  'cleanup':'R passed to free at 4257758 on another selected state'},
 'conclusion':'The ordinary return is a length/data record used to construct a std::string through its data pointer; it is not passed directly as char-buffer data.',
 'limits':'These are exact local store/load and return edges, not an exhaustive flattened-path proof. A separately checked consumer path copies lookup-object data into the returned record data allocation. OR8 propagation still requires proof of related lookup entries, copy/output coverage of the changed byte, and reachable write-before-copy order. Separate allocations alone do not rule out propagation. No semantic signature/token/extra names or detection validity claimed. No native execution.'},indent=2))
