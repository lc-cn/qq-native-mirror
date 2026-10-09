#!/usr/bin/env python3
"""Generate minimal import-thunk exports after checking official Node exports and machine."""
import sys,json,importlib.util
from pathlib import Path
s=importlib.util.spec_from_file_location('pe',Path(__file__).with_name('pe-inspect.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
r=json.loads(Path(sys.argv[1]).read_text());node=m.PE(sys.argv[2]);exports=node.exports()
if hex(node.machine)!=r['machine']:raise SystemExit('Node architecture mismatch')
lines=['LIBRARY QQNT','EXPORTS'];missing=[]
for name in r['requiredQQNTExports']:
 target='napi_module_register' if name=='qq_magic_napi_register' else name
 if target not in exports:missing.append(target)
 lines.append(f' {name}' + (f'={target}' if name != target else ''))
if missing:raise SystemExit('Missing Node exports: '+json.dumps(missing))
Path(sys.argv[3]).write_text('\n'.join(lines)+'\n');print(json.dumps({'exports':len(lines)-2,'machine':r['machine'],'nodeExportsVerified':True,'linkCommand':'link /dll /noentry /machine:ARM64 (or X64) /def:QQNT.def /out:QQNT.dll','abiCaution':'Export presence does not validate V8/Node C++ or libuv ABI; real native prepare still required'}))
