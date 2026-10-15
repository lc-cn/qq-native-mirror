#!/usr/bin/env python3
"""Recover one constant native substring predicate from bytes; never runs native code."""
import contextlib,io,runpy,json
with contextlib.redirect_stdout(io.StringIO()):e=runpy.run_path('scripts/linux-signing-provider-map.py')
ins=e['instruction']
# MOV-immediate / STURB pairs in the verified constructor block.
regs={};stack={}
for a in range(0x4262a28,0x4262ac0,4):
 w=ins(a)
 if w&0xff800000==0x52800000:regs[w&31]=((w>>5)&65535)<<(((w>>21)&3)*16)
 elif w&0xff800000==0x72800000:
  r=w&31;shift=((w>>21)&3)*16;regs[r]=(regs.get(r,0)&~(65535<<shift))|(((w>>5)&65535)<<shift)
 elif w&0xffe00c00==0x38000000 and (w>>5)&31==29:
  n=(w>>12)&511;n=n-512 if n&256 else n;stack[n]=regs[w&31]&255
initial=bytes(stack[-0x20+i] for i in range(14))
checks={0x4262ce8:0xf100313f,0x4262d30:0x4a0b0129,0x4262d34:0x4a0a0129,0x4262d38:0x521e0529,0x4262d84:0x381ef3bf,0x4262dd4:0x97176193}
for a,w in checks.items():
 if ins(a)!=w:raise SystemExit(f'Instruction mismatch {hex(a)}')
decoded=bytes(initial[i+2]^initial[1]^(i+1)^12 for i in range(12))
if decoded!=b'wrapper.node':raise SystemExit('Unexpected recovered predicate')
print(json.dumps({'sha256':e['base']['expected'],'constructor':['0x4262a28','0x4262abc'],'initialStackBytesHex':initial.hex(),'decodeLength':12,'decodeFormula':'initial[i+2] XOR initial[1] XOR (i+1) XOR 0x0c','recoveredSubstring':decoded.decode(),'terminatorAt':'0x4262d84','comparison':'strstr(dladdr(caller return address).dli_fname, recoveredSubstring) at 0x4262dd4','scope':'substring match, not full path/hash/signature integrity verification; no native execution'},indent=2))
