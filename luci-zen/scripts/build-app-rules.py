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

def list_map(manifest):
    """Map every source list name to its manifest service.

    Upstream splits one brand across several lists (bilibili, bilibili-cdn,
    bilibili-game). Matching only the service key silently dropped the CDN
    lists, so a manifest entry may declare extra ``lists``.
    """
    mapping = {}
    for service, item in manifest['services'].items():
        names = item.get('lists', [service])
        if not names or len(set(names)) != len(names):
            raise ValueError('Duplicate or empty list alias for ' + service)
        for name in names:
            if not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,80}', name):
                raise ValueError('Invalid list alias: ' + name)
            owner = mapping.get(name)
            if owner and owner != service:
                raise ValueError('List ' + name + ' claimed by ' + owner + ' and ' + service)
            mapping[name] = service
    return mapping

def build(args):
    manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    version=args.version or manifest['version']
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,63}',version or ''):raise ValueError('Invalid package version')
    source=args.source
    lists=list_map(manifest)
    rows=[];skipped=[];ignored=[]
    if source.is_file():
        data=json.loads(source.read_text(encoding='utf-8'))
        if data.get('schema')!=1 or data.get('license')!='MIT':raise ValueError('Only schema-1 MIT domain metadata is supported')
        revision=data['revision']
        sources={row['id']:row for row in data.get('sources',[])}
        for mode in ['exact','suffix']:
            for host,services in sorted(data[mode].items()):
                for name in services:
                    service=lists.get(name)
                    if service is None:
                        # Out of scope brands stay dropped, but in-scope lists we
                        # never mapped must be visible instead of silent.
                        if any(name==s or name.startswith(s+'-') for s in manifest['services']):
                            ignored.append(name+':'+host)
                        continue
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
                if '@ads' in item[1:]:skipped.append(service+':'+token+' @ads');continue
                if token.startswith('include:'):collect(service,token[8:],stack+[name]);continue
                if token.startswith(('regexp:','keyword:')):skipped.append(service+':'+token);continue
                mode='exact' if token.startswith('full:') else 'suffix'
                rows.append((service,domain(token.removeprefix('full:').removeprefix('domain:')),mode,'dlc',revision))
                if len(rows)>100000:raise ValueError('Excessive source rules')
        for service,item in manifest['services'].items():
            for name in item.get('lists',[service]):collect(service,name,[])
    rules={};conflicts=set()
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
            conflicts.add((host,mode))
            previous['level']='candidate';continue
        if (host,mode) in conflicts:
            rule['level']='candidate'
        rules[(host,mode)]=rule
    # The manifest is the review record: a curated domain that upstream lacks
    # must still ship, and callers must be able to see it happened.
    manifest_only=[]
    for service,item in sorted(manifest['services'].items()):
        for host in item['dedicated']:
            host=domain(host)
            previous=rules.get((host,'suffix')) or rules.get((host,'exact'))
            if previous is not None:
                if previous['app']!=item['app']:
                    previous['level']='candidate'
                continue
            rules[(host,'suffix')]={'domain':host,'match':'suffix','app':item['app'],'level':'dedicated',
                'source':'zen-reviewed','revision':version,'license':'MIT'}
            manifest_only.append(service+':'+host)
    for host,key in manifest['infrastructure'].items():
        rules[(host,'suffix')]={'domain':domain(host),'match':'suffix','app':key,'level':'infrastructure','source':'zen-reviewed','revision':version,'license':'MIT'}
    result={'schema':1,'version':version,'source_revision':revision,'rules':sorted(rules.values(),key=lambda r:(r['domain'],r['match'])),'features':[]}
    encoded=(json.dumps(result,ensure_ascii=True,indent=2)+'\n').encode()
    if len(encoded)>524288 or len(rules)>2048:raise ValueError('Selected rule package exceeds limits')
    args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_bytes(encoded)
    print(json.dumps({'rules':len(rules),'dedicated':sum(r['level']=='dedicated' for r in rules.values()),
        'manifest_only':manifest_only,'unmapped_lists':sorted(set(ignored)),'skipped':skipped,
        'sha256':hashlib.sha256(encoded).hexdigest()}))

def verify(args):
    """Re-check a packaged file against the manifest; needs no upstream source.

    The daemon compiles this package into the binary, so a silent regression
    here would ship without any build failure.
    """
    manifest=json.loads(args.manifest.read_text(encoding='utf-8'))
    raw=args.verify.read_bytes()
    package=json.loads(raw.decode('utf-8'))
    if package.get('schema')!=1:raise ValueError('Unexpected schema')
    if package['version']!=manifest['version']:
        raise ValueError(f"Packaged version {package['version']} != manifest {manifest['version']}")
    if not re.fullmatch(r'[a-f0-9]{40}',package.get('source_revision') or ''):
        raise ValueError('Missing source revision')
    made={(r['domain'],r['match']) for r in package['rules']}
    missing=[service+':'+host for service,item in manifest['services'].items()
        for host in item['dedicated'] if (host,'suffix') not in made and (host,'exact') not in made]
    if missing:raise ValueError('Dedicated domains missing: '+', '.join(missing))
    owners={}
    for rule in package['rules']:
        key=(rule['domain'],rule['match'])
        domain(rule['domain'])
        if rule['level'] not in ('dedicated','candidate','infrastructure'):raise ValueError('Bad level for '+str(key))
        if rule['match'] not in ('suffix','exact'):raise ValueError('Bad match for '+str(key))
        if key in owners:raise ValueError('Duplicate rule for '+str(key))
        owners[key]=rule['app']
        if rule.get('license')!='MIT':raise ValueError('Unsupported rule license')
    for service,item in manifest['services'].items():
        for host in item['dedicated']:
            matches=[r for r in package['rules'] if r['domain']==host]
            if not any(r['app']==item['app'] and r['level']=='dedicated' for r in matches):
                raise ValueError('Reviewed ownership/level mismatch: '+service+':'+host)
    if len(raw)>524288 or len(package['rules'])>2048:raise ValueError('Rule package exceeds limits')
    dedicated={r['domain'] for r in package['rules'] if r['level']=='dedicated'}
    for service in manifest['services'].values():
        if service['app']=='community:bilibili':
            absent=[d for d in ('bilivideo.com','bilivideo.cn','hdslb.com','bilicdn1.com','biliimg.com') if d not in dedicated]
            if absent:raise ValueError('Bilibili CDN domains missing: '+', '.join(absent))
    print(json.dumps({'rules':len(package['rules']),'version':package['version'],'verified':True}))

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest',type=Path,default=Path(__file__).parents[1]/'rules/review.json')
    parser.add_argument('--source',type=Path)
    parser.add_argument('--revision')
    parser.add_argument('--output',type=Path)
    parser.add_argument('--version',help='Override the manifest version for this build')
    parser.add_argument('--verify',type=Path,help='Validate an existing package against the manifest')
    args=parser.parse_args()
    if args.verify:
        verify(args)
    elif not args.source or not args.output:
        parser.error('--source and --output are required unless --verify is used')
    else:
        build(args)
