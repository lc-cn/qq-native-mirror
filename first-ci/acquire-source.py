"""Download an immutable source candidate only when run by reviewed CI."""
import os,json,subprocess,hashlib,base64,tarfile,re
from pathlib import Path
REPO='lc-cn/qq-native-mirror'
def sha(b):return hashlib.sha256(b).hexdigest()
def gh(path):return json.loads(subprocess.check_output(['gh','api',path]))
def safe(s):
 if not isinstance(s,str) or not s or '\\'in s or ':'in s or '\0'in s or s.startswith('/') or any(p in ('','.','..')for p in s.split('/')):raise ValueError('Unsafe path')
 return s
def inspect_tar(path):
 with tarfile.open(path,'r:gz')as tar:
  entries=tar.getmembers();names=set()
  for m in entries:
   n=m.name.rstrip('/') if m.isdir()else m.name;safe(n)
   if not n.startswith('package/') and n!='package':raise ValueError('Missing package prefix')
   if n in names or not(m.isdir()or m.isfile())or m.issym()or m.islnk():raise ValueError('Unsafe or duplicate tar entry')
   names.add(n)
  if sum(m.size for m in entries)>2*1024**3:raise ValueError('Archive too large')
  return {m.name:tar.extractfile(m).read()for m in entries if m.isfile()}
def verified(data,p):
 assert len(data)==p['size'] and sha(data)==p['sha256'] and 'sha512-'+base64.b64encode(hashlib.sha512(data).digest()).decode()==p['integrity']
def main():
 tag=os.environ['SOURCE_TAG'];match=re.fullmatch(r'npm-v(\d+\.\d+\.\d+)-ci-(\d+)',tag)
 if not match:raise ValueError('Invalid source tag')
 release=gh(f'repos/{REPO}/releases/tags/{tag}');assert release['tag_name']==tag and not release['draft'] and release['prerelease']
 assets={a['name']:a for a in release['assets']};out=Path('out');out.mkdir(exist_ok=True)
 def download(name):
  safe(name);asset=assets[name];assert isinstance(asset['size'],int) and 0<asset['size']<=512*1024**2 and re.fullmatch(r'sha256:[a-f0-9]{64}',asset.get('digest','')) and asset['browser_download_url']==f'https://github.com/{REPO}/releases/download/{tag}/{name}'
  subprocess.check_call(['gh','release','download',tag,'--repo',REPO,'--pattern',name,'--dir',str(out),'--clobber'])
  b=(out/name).read_bytes();assert len(b)==asset['size'] and 'sha256:'+sha(b)==asset['digest'];return b
 body=download('release-manifest.json');manifest=json.loads(body)
 assert release['target_commitish']==manifest['commit']
 expected={'qq-native-client'}|{'qq-native-client-'+d for d in ['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64']}
 assert len(manifest['packages'])==7 and {p['name']for p in manifest['packages']}==expected
 assert all(p['version']==manifest['version']for p in manifest['packages'])
 assert len({p['tarball']for p in manifest['packages']})==7
 assert manifest['schemaVersion']==1 and manifest['repository']==REPO and manifest['runId']==match[2] and manifest['version']==match[1]
 sdk=json.loads(Path('sdk/package.json').read_text());assert sdk['version']==manifest['version']
 for device in ['linux-x64','linux-arm64','darwin-x64','darwin-arm64','win32-x64','win32-arm64']:assert sdk['optionalDependencies']['qq-native-client-'+device]==manifest['version']
 run=gh(f'repos/{REPO}/actions/runs/{manifest["runId"]}');assert str(run['id'])==manifest['runId'] and run['status']=='completed' and run['conclusion']=='success' and run['head_sha']==manifest['commit'] and run['run_attempt']==manifest['runAttempt']
 assert run['path'] in ['.github/workflows/native-npm.yml','.github/workflows/native-first-main.yml'] and run['repository']['full_name']==REPO
 platform=os.environ['TARGET_PLATFORM'];arch=os.environ['TARGET_ARCH'];name=f'qq-native-client-{platform}-{arch}'
 p=next(p for p in manifest['packages']if p['name']==name);b=download(p['tarball']);verified(b,p);files=inspect_tar(out/p['tarball'])
 nativebody=files['package/manifest.json'];assert sha(nativebody)==p['manifestSha256'];native=json.loads(nativebody);pkg=json.loads(files['package/package.json'])
 assert native['schemaVersion']==1 and native['platform']==platform and native['arch']==arch and pkg['name']==name and pkg['version']==manifest['version']
 assert pkg['os']==[platform] and pkg['cpu']==[arch]
 if platform=='linux':assert pkg['libc']==['glibc']
 if platform=='win32':assert re.fullmatch(r'v\d+\.\d+\.\d+',native['nodeVersion']) and re.fullmatch(r'[a-f0-9]{64}',native['nodeConfigSha256']) and pkg['engines']['node']==native['nodeVersion'][1:]
 seen=set()
 for f in native['files']:
  path=safe(f['path']);assert path not in seen;seen.add(path);data=files['package/'+path];assert sha(data)==f['sha256']
  if 'size'in f:assert len(data)==f['size']
 assert safe(native['wrapper'])in seen
 bridge='QQNT.dll'if platform=='win32'else'registration-bridge.node'
 for name in [bridge]+(['NODE-LICENSE.txt']if platform=='win32'else[]):
  assert name in seen
  for base in [Path('sdk/native')/f'{platform}-{arch}',out/'bridges'/f'{platform}-{arch}']:
   base.mkdir(parents=True,exist_ok=True);(base/name).write_bytes(files['package/'+name])
 local=out/'source-native';local.mkdir(exist_ok=True)
 for f in native['files']:
  path=local/f['path'];path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(files['package/'+f['path']])
 (local/'manifest.json').write_bytes(nativebody)
 provenance={'schemaVersion':1,'sourceTag':tag,'sourceRepository':REPO,'sourceCommit':manifest['commit'],'sourceRunId':manifest['runId'],'sourceRunAttempt':manifest['runAttempt'],'releaseManifestSha256':sha(body),'assetDigest':assets[p['tarball']]['digest'],'package':p,'target':f'{platform}-{arch}','reusedAuxiliaryBytes':True}
 (out/'source-provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
if __name__=='__main__':main()
