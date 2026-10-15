#!/usr/bin/env python3
"""Read-only ASAR inventory; never loads major.node or executes app scripts."""
import hashlib,json,struct,sys
from pathlib import Path
root=Path(sys.argv[1] if len(sys.argv)>1 else '/Applications/QQ.app/Contents/Resources/app')
b=(root/'application.asar').read_bytes()
if len(b)<16:raise SystemExit('Truncated ASAR')
_,header_bytes,_,json_bytes=struct.unpack('<IIII',b[:16])
if json_bytes>64*1024*1024 or 16+json_bytes>len(b):raise SystemExit('Invalid ASAR header')
h=json.loads(b[16:16+json_bytes]);base=8+header_bytes
if base<16+json_bytes or base>len(b):raise SystemExit('Invalid ASAR payload offset')
def walk(d,p=''):
 for name,value in d.get('files',{}).items():
  path=p+'/'+name
  if 'files' in value:yield from walk(value,path)
  else:yield path,value
terms=['initWithDeskTopConfig','setQIMEI','setAppSigned','SecuritySign','createEngine','initConfig','major.node','internal_index']
files=list(walk(h));matches=[];checked=0;integrity_failures=[];samples=[]
for path,value in files:
 if not path.endswith('.js') or value.get('unpacked') or 'offset' not in value:continue
 start=base+int(value['offset']);end=start+value['size']
 if start<base or end>len(b):raise SystemExit('Invalid ASAR member range')
 data=b[start:end];checked+=1
 integrity=value.get('integrity',{})
 if integrity.get('algorithm')=='SHA256' and hashlib.sha256(data).hexdigest()!=integrity.get('hash'):integrity_failures.append(path)
 counts={term:data.count(term.encode()) for term in terms if term.encode() in data}
 if counts:matches.append({'path':path,'matches':counts})
 if path in ['/app_launcher/index.js','/app_launcher/launcher.js']:
  try:data.decode('utf-8');utf8=True
  except UnicodeDecodeError:utf8=False
  samples.append({'path':path,'size':len(data),'utf8Decodable':utf8})
package=json.loads((root/'package.json').read_text())
print(json.dumps({'clientVersion':package.get('version'),'byteCodeShellMetadata':package.get('isByteCodeShell'),'asarSha256':hashlib.sha256(b).hexdigest(),'memberCount':len(files),'packedJsInspected':checked,'initializationTermMatches':matches,'memberIntegrityFailures':integrity_failures,'launcherArchiveSamples':samples,'outerLauncherFiles':{p:(root/p).read_text() for p in ['app_launcher/index.js','app_launcher/launcher.js']},'mainReferencesNapCat': 'napcat' in str(package.get('main','')).lower(),'executedNative':False,'accountAccessed':False},indent=2))
