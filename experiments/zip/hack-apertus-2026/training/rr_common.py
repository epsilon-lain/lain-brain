"""Small, explicit evidence primitives. No model import; no hidden text repair."""
import copy
import hashlib
import json
import os
from pathlib import Path
import uuid
from zip_content_core import digest

PROTOCOL='lain-zip-reflection-reward-final-v23'


def require(condition,message):
    if not condition:raise ValueError(message)


def read(path):return json.loads(Path(path).read_text(encoding='utf-8'))


def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for part in iter(lambda:f.read(1024*1024),b''):h.update(part)
    return h.hexdigest()


def sealed(value):
    value=copy.deepcopy(value);value['hash']=digest(value);return value


def check_seal(value):
    require(value['hash']==digest({k:v for k,v in value.items() if k!='hash'}),'Evidence hash changed')
    return value


def atomic_json(path,value):
    path=Path(path);path.parent.mkdir(parents=True,exist_ok=True)
    temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        with temp.open('x',encoding='utf-8') as f:
            json.dump(value,f,ensure_ascii=False,indent=2,allow_nan=False);f.write('\n');f.flush();os.fsync(f.fileno())
        os.replace(temp,path)
        fd=os.open(path.parent,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    finally:
        if temp.exists():temp.unlink()


def put_once(path,value):
    if Path(path).is_file():require(read(path)==value,'Refuse to replace committed evidence: '+str(path))
    else:atomic_json(path,value)
    return value


def raw(record):return record['studentOutput']['raw']
