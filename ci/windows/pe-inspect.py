#!/usr/bin/env python3
"""Read PE imports, delay imports and exports without loading the binary."""
import struct,json,sys
from pathlib import Path
class PE:
 def __init__(self,path):
  self.b=Path(path).read_bytes();b=self.b;o=struct.unpack_from('<I',b,60)[0]
  if b[o:o+4]!=b'PE\0\0':raise ValueError('Not PE')
  self.machine,n=struct.unpack_from('<HH',b,o+4);size=struct.unpack_from('<H',b,o+20)[0];opt=o+24;magic=struct.unpack_from('<H',b,opt)[0];self.ptr=8 if magic==523 else 4
  dd=opt+(112 if self.ptr==8 else 96);self.dirs=[struct.unpack_from('<II',b,dd+i*8) for i in range(16)]
  self.sections=[struct.unpack_from('<8sIIIIIIHHI',b,opt+size+i*40) for i in range(n)]
 def off(self,r):
  for s in self.sections:
   if s[2]<=r<s[2]+max(s[1],s[3]):return s[4]+r-s[2]
  if r<self.sections[0][2]:return r
  raise ValueError('Unmapped RVA '+hex(r))
 def string(self,r):return self.b[self.off(r):].split(b'\0',1)[0].decode('ascii')
 def imports(self):
  out=[]
  for index,delay in [(1,False),(13,True)]:
   r,z=self.dirs[index]
   if not r:continue
   o=self.off(r);width=32 if delay else 20
   while True:
    row=struct.unpack_from('<'+'I'*(width//4),self.b,o);o+=width
    if not any(row):break
    if delay:
     if not row[0]&1:raise ValueError('VA delay imports unsupported')
     name,thunk=row[1],row[4]
    else:thunk,name=row[0] or row[4],row[3]
    ts=[];t=self.off(thunk)
    while True:
     v=struct.unpack_from('<Q' if self.ptr==8 else '<I',self.b,t)[0];t+=self.ptr
     if not v:break
     ts.append({'ordinal':v&65535} if v&(1<<(self.ptr*8-1)) else {'name':self.string(v+2)})
    out.append({'dll':self.string(name),'delay':delay,'symbols':ts})
  return out
 def exports(self):
  r,z=self.dirs[0]
  if not r:return {}
  x=struct.unpack_from('<IIHHIIIIIII',self.b,self.off(r));base,count,n,fs,ns,os=x[5:];out={}
  for i in range(n):
   name=self.string(struct.unpack_from('<I',self.b,self.off(ns)+i*4)[0]);ordinal=struct.unpack_from('<H',self.b,self.off(os)+i*2)[0];a=struct.unpack_from('<I',self.b,self.off(fs)+ordinal*4)[0]
   out[name]={'ordinal':base+ordinal,'forwarder':self.string(a) if r<=a<r+z else None}
  return out
if __name__=='__main__':
 p=PE(sys.argv[1]);print(json.dumps({'machine':hex(p.machine),'imports':p.imports(),'exports':p.exports()},indent=2))
