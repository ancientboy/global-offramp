#!/usr/bin/env python3
"""Package reviewed runtime artifacts, never local dependencies, tests, credentials or backups."""
import argparse,hashlib,io,json,subprocess,tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[2]
p=argparse.ArgumentParser();p.add_argument('output');a=p.parse_args()
if subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip():raise SystemExit('Commit the reviewed source before packaging')
commit=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
blocked={'node_modules','.git','.next','.openai','.cc-connect','private','recovery','__pycache__','test','tests','coverage','qa','.DS_Store'}
manifest={}
def select(info):
 path=Path(info.name);name=path.name
 if any(part in blocked for part in path.parts) or info.issym() or info.islnk():return None
 if name.startswith('.env') and name!='.env.example':return None
 if name.endswith(('.dump','.log','.key','.pem','.pfx','.p12','.pyc','.tgz','.tar','.zip')):return None
 if path.parts[0]=='deploy' and path.suffix=='.json' and name not in {'package.json','package-lock.json'}:return None
 if name=='hosting.json':return None
 if info.isfile():manifest[info.name]=hashlib.sha256((root/info.name).read_bytes()).hexdigest()
 return info
with tarfile.open(a.output,'w:gz') as out:
 for part in ['dist','sites-dist','db','db-runtime.sql','deploy','package.json','package-lock.json']:out.add(root/part,arcname=part,filter=select)
 content=(json.dumps({'commit':commit,'sha256':manifest},sort_keys=True,indent=2)+'\n').encode();entry=tarfile.TarInfo('release-manifest.json');entry.size=len(content);entry.mode=0o644;out.addfile(entry,io.BytesIO(content))
print('Sanitized runtime release prepared for '+commit[:12])
