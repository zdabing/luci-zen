#!/usr/bin/env python3
"""Offline, reproducible DLC/BetterDPI metadata importer; no network or code execution.

Only the explicit review manifest can promote a community domain to dedicated.
Unknown includes/regex are reported instead of expanded into broad classifications.
"""
import argparse,hashlib,json,re
from pathlib import Path

def domain(value):
    value=value.lower().removesuffix('.')
    if len(value)>253 or not all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?',x) for x in value.split('.')):
        raise ValueError('Invalid domain: '+value)
    return value

def build(args):
    manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    source=args.source
    rows=[];skipped=[]
    if source.is_file():
        data=json.loads(source.read_text(encoding='utf-8'))
        if data.get('schema')!=1 or data.get('license')!='MIT':raise ValueError('Only schema-1 MIT domain metadata is supported')
        revision=data['revision']
        sources={row['id']:row for row in data.get('sources',[])}
        for mode in ['exact','suffix']:
            for host,services in sorted(data[mode].items()):
                for service in services:
                    if service in manifest['services']:
                        source_id=data.get('rule_sources',{}).get(mode,{}).get(host,data.get('default_rule_source','dlc'))
                        metadata=sources.get(source_id,{'revision':revision,'license':'MIT'})
                        if metadata.get('license')!='MIT':raise ValueError('Unsupported source license')
                        rows.append((service,domain(host),mode,source_id,metadata['revision']))
    else:
        revision=args.revision
        if not re.fullmatch(r'[a-f0-9]{40}',revision or ''):raise ValueError('DLC commit SHA required')
        def collect(service,name,stack):
            if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,80}',name):raise ValueError('Invalid include name')
            if name in stack or len(stack)>=16:raise ValueError('Cyclic or excessive includes')
            path=source/name
            if not path.is_file():raise ValueError('Missing source list: '+name)
            for raw in path.read_text(encoding='utf-8').splitlines():
                item=raw.split('#',1)[0].strip().split()
                if not item:continue
                token=item[0]
                if token.startswith('include:'):collect(service,token[8:],stack+[name]);continue
                if token.startswith(('regexp:','keyword:')):skipped.append(service+':'+token);continue
                mode='exact' if token.startswith('full:') else 'suffix'
                rows.append((service,domain(token.removeprefix('full:').removeprefix('domain:')),mode,'dlc',revision))
                if len(rows)>100000:raise ValueError('Excessive source rules')
        for service in manifest['services']:collect(service,service,[])
    rules={}
    for service,host,mode,source_id,source_revision in rows:
        item=manifest['services'][service]
        if service=='tencent' and host not in item['dedicated'] and host not in manifest['infrastructure']:continue
        level='dedicated' if host in item['dedicated'] else 'candidate'
        key=item['app']
        if host in manifest['infrastructure']:
            level='infrastructure';key=manifest['infrastructure'][host]
        rule={'domain':host,'match':mode,'app':key,'level':level,'source':source_id,'revision':source_revision,'license':'MIT'}
        # A multi-service community domain never becomes direct application evidence.
        previous=rules.get((host,mode))
        if previous and previous['app']!=key:
            previous['level']='candidate';continue
        rules[(host,mode)]=rule
    for host,key in manifest['infrastructure'].items():
        rules[(host,'suffix')]={'domain':domain(host),'match':'suffix','app':key,'level':'infrastructure','source':'zen-reviewed','revision':manifest['version'],'license':'MIT'}
    result={'schema':1,'version':manifest['version'],'source_revision':revision,'rules':sorted(rules.values(),key=lambda r:(r['domain'],r['match'])),'features':[]}
    encoded=(json.dumps(result,ensure_ascii=True,indent=2)+'\n').encode()
    if len(encoded)>524288 or len(rules)>2048:raise ValueError('Selected rule package exceeds limits')
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(encoded)
    print(json.dumps({'rules':len(rules),'dedicated':sum(r['level']=='dedicated' for r in rules.values()),'skipped':skipped,'sha256':hashlib.sha256(encoded).hexdigest()}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--manifest',type=Path,default=Path(__file__).parents[1]/'rules/review.json')
    parser.add_argument('--revision');parser.add_argument('--output',type=Path,required=True)
    build(parser.parse_args())
