#!/usr/bin/env python3
"""Static vendor PE closure; excludes official QQNT host in favor of built forwarder."""
import importlib.util,sys,json,re,hashlib,shutil
from pathlib import Path
from urllib.parse import quote
spec=importlib.util.spec_from_file_location('pe',Path(__file__).with_name('pe-inspect.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(sys.argv[1]).resolve();dest=Path(sys.argv[2]).resolve()
if dest.exists():raise SystemExit('Destination must be new')
meta=json.loads((root/'resources/app/package.json').read_text());major=(root/'resources/app/major.node').read_bytes();ids=set(re.findall(rb'QQAppId/(\d+)',major));quas=set(re.findall(rb'V1_WIN_[A-Za-z0-9_.-]+',major))
if len(ids)!=1 or len(quas)!=1:raise SystemExit('Ambiguous native appId/QUA')
entry=root/'resources/app/wrapper.node';machine=m.PE(entry).machine;arch={0x8664:'x64',0xaa64:'arm64'}[machine]
byname={}
for p in root.rglob('*'):
 if p.is_file():byname.setdefault(p.name.lower(),[]).append(p)
queue=[entry];seen=set();files=[];external=[];edges=[];forward=set()
while queue:
 p=queue.pop(0)
 if p in seen:continue
 seen.add(p);pe=m.PE(p)
 if pe.machine!=machine:raise SystemExit('Wrong vendor architecture '+str(p))
 for d in pe.imports():
  name=d['dll'];low=name.lower()
  if low=='qqnt.dll':
   for s in d['symbols']:
    if 'name' not in s:raise SystemExit('QQNT ordinal import unsupported')
    forward.add(s['name'])
   edges.append({'from':p.name,'dll':name,'generatedForwarder':True});continue
  candidates=[] if low.startswith(('api-ms-','ext-ms-')) else [q for q in byname.get(low,[]) if m.PE(q).machine==machine]
  candidates=[q for q in candidates if q.parent==p.parent] or [q for q in candidates if q.parent==root/'resources/app'] or [q for q in candidates if q.parent==root] or candidates
  if candidates:
   hashes={hashlib.sha256(q.read_bytes()).hexdigest() for q in candidates}
   if len(hashes)>1:raise SystemExit('Ambiguous vendor DLL '+name)
   q=candidates[0];queue.append(q);edges.append({'from':p.name,'dll':name,'vendorSource':q.relative_to(root).as_posix()})
  else:external.append({'requiredBy':p.name,'dll':name,'delay':d['delay']})
# Flat DLL layout intentionally makes generated QQNT.dll sibling of wrapper; unique names required.
if len({p.name.lower() for p in seen})!=len(seen):raise SystemExit('Conflicting flat layout')
dest.mkdir(parents=True)
for p in sorted(seen):
 q=dest/p.name;shutil.copyfile(p,q);b=q.read_bytes();files.append({'path':p.name,'url':quote(p.name),'size':len(b),'sha256':hashlib.sha256(b).hexdigest()})
v={'clientVersion':meta['version'],'appId':next(iter(ids)).decode(),'qua':next(iter(quas)).decode()}
manifest={'schemaVersion':1,'id':f"qq-{meta['version']}-win32-{arch}",'platform':'win32','arch':arch,'wrapper':'wrapper.node','version':v,'files':files}
(dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
report={'machine':hex(machine),'metadataSources':{'version':'package.json.version','appId':'major.node unique marker','qua':'major.node literal','majorSha256':hashlib.sha256(major).hexdigest()},'vendorEdges':edges,'externalLibraries':external,'requiredQQNTExports':sorted(forward),'requiresGeneratedQQNT':True,'limitations':['Not runnable until architecture-matched QQNT.dll forwarder built and added to manifest','Static import/delay-import closure only; runtime dynamic dependencies unverified']}
(dest/'dependency-report.json').write_text(json.dumps(report,indent=2)+'\n')
for f in files:
 data=(dest/f['path']).read_bytes()
 if len(data)!=f['size'] or hashlib.sha256(data).hexdigest()!=f['sha256']:raise SystemExit('Copy verification failed')
print(json.dumps({'destination':str(dest),'arch':arch,'files':len(files),'bytes':sum(f['size'] for f in files),'qqntExports':len(forward),'version':v}))
