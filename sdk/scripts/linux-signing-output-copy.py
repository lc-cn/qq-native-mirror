#!/usr/bin/env python3
"""Verify only the provider-to-callback output copy boundary; static bytes only."""
import contextlib,io,runpy,json
with contextlib.redirect_stdout(io.StringIO()): e=runpy.run_path('scripts/linux-signing-provider-map.py')
checks={0x1375c78:0x39447fe2,0x1375c84:0x9401ea6c,0x1375c88:0x91006260,0x1375c90:0x39487fe2,0x1375c94:0x9401ea68,0x1375c98:0x9100c260,0x1375ca0:0x394c7fe2,0x1375ca4:0x9401ea64,0x13f06fc:0x97d12801,0x13f073c:0x97d12719,0x13f0754:0xf9000693,0x13f075c:0x38336adf}
for a,w in checks.items():
 if e['instruction'](a)!=w:raise SystemExit(f'Instruction mismatch {hex(a)}')
print(json.dumps({'sha256':e['base']['expected'],'conversion':'length-delimited byte copy into three 24-byte string-shaped result slots; allocation/inline storage and trailing zero','copyHelper':'0x13f0634','regions':[{'providerOffset':hex(x),'lengthByteOffset':hex(x+255),'resultSlotOffset':hex(y)} for x,y in [(0,0),(256,24),(512,48)]],'memcpy':'0x13f06fc','memmove':'0x13f073c','trailingZero':'0x13f075c','semanticFieldNames':'unknown; no authoritative signature/token/extra assignment','limits':'Does not connect the earlier conditional OR8 byte to any provider region. No native execution.'},indent=2))
