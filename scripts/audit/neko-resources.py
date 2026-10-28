"""Bounded resource sample of a NEW disposable Neko, no production defaults."""
import json, subprocess, sys, time, urllib.request
from pathlib import Path
config_path=Path(sys.argv[1]);name=config_path.parent.name
assert name.startswith('maw-neko-integration-audit-')
assert subprocess.check_output(['docker','inspect','--format','{{index .Config.Labels "maw.audit"}}',name],text=True).strip()=='true'
config=json.loads(config_path.read_text());base=config['NEKO_CONTROLLER_URL'];headers={'Authorization':'Bearer '+config['CONTROLLER_AUTH_TOKEN'],'Content-Type':'application/json'}
def request(route,method='GET',body=None):
    req=urllib.request.Request(base+route,headers=headers,method=method,data=None if body is None else json.dumps(body).encode())
    with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
for i in range(40):
    try:request('/health');break
    except Exception:time.sleep(.5)
initial=request('/tabs')['tabs'];assert len(initial)<=1,'Use a fresh fixture only'
(config_path.parent/'initial-tabs-backup.json').write_text(json.dumps(initial))
for tab in initial:request('/tabs/'+tab['id'],'DELETE')
probe='''import os,json
out={}
for p in os.listdir('/proc'):
 if not p.isdigit():continue
 try:
  comm=open('/proc/'+p+'/comm').read().strip()
  group='chromium' if comm in ('chromium','chrome','chrome_crashpad') else 'neko' if comm=='neko' else 'other'
  row=out.setdefault(group,{'rssKiB':0,'pssKiB':0,'ticks':0,'processes':0})
  stat=open('/proc/'+p+'/stat').read().rsplit(')',1)[1].split()
  row['ticks']+=int(stat[11])+int(stat[12]);row['processes']+=1
  for line in open('/proc/'+p+'/smaps_rollup'):
   fields=line.split()
   if fields[0]=='Rss:':row['rssKiB']+=int(fields[1])
   if fields[0]=='Pss:':row['pssKiB']+=int(fields[1])
 except (OSError,IndexError):
  if 'row' in locals():row['unreadableProcesses']=row.get('unreadableProcesses',0)+1
print(json.dumps({'hz':os.sysconf('SC_CLK_TCK'),'groups':out}))'''
def sample():return json.loads(subprocess.check_output(['docker','exec','--user','neko',name,'python3','-c',probe],text=True))
results=[];created=[]
for count in [1,5,10,15]:
    while len(created)<count:
        created.append(request('/tabs','POST',{'url':'https://chatgpt.com/'})['id'])
    for phase in ['loading','settled']:
        start=time.monotonic();a=sample();time.sleep(3);b=sample();elapsed=time.monotonic()-start
        for group,row in b['groups'].items():row['cpuPercentOneCore']=max(0,(row['ticks']-a['groups'].get(group,{}).get('ticks',0))/b['hz']/elapsed*100)
        results.append({'tabs':count,'actualTargets':len(request('/tabs')['tabs']),'phase':phase,'intervalSeconds':elapsed,**b})
(config_path.parent/'tabs-before-cleanup.json').write_text(json.dumps(request('/tabs')))
print(json.dumps({'container':name,'workload':'fresh unauthenticated ChatGPT pages; no generation, no viewer; shared host; 3s samples; settled does not guarantee page idle','results':results},indent=2))
for target in created:request('/tabs/'+target,'DELETE')
