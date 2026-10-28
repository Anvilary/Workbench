"""Create a fresh audit-only Neko; prints only config path and container ID. Never uses production env/volumes."""
import json, os, secrets, socket, subprocess, tempfile
from pathlib import Path
repo = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='maw-neko-integration-audit-'))
name = root.name
# Docker allocates available loopback TCP ports. Reserve a fresh contiguous UDP range.
for base in range(54000, 60000, 11):
    sockets=[]
    try:
        for port in range(base,base+11):
            s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',port));sockets.append(s)
        break
    except OSError:
        for s in sockets:s.close()
else: raise RuntimeError('No free fixture UDP range')
password, admin, token = [secrets.token_hex(32) for _ in range(3)]
env={'NEKO_SERVER_BIND':'0.0.0.0:8080','NEKO_SERVER_PATH_PREFIX':'/api/agency/browser/viewer','NEKO_SESSION_COOKIE_ENABLED':'true','NEKO_DESKTOP_SCREEN':'1280x720@30','NEKO_WEBRTC_NAT1TO1':'127.0.0.1','NEKO_WEBRTC_EPR':f'{base}-{base+10}','NEKO_WEBRTC_ICELITE':'true','NEKO_MEMBER_PROVIDER':'multiuser','NEKO_MEMBER_MULTIUSER_USER_PASSWORD':password,'NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD':admin,'CONTROLLER_AUTH_TOKEN':token,'CDP_HOST':'127.0.0.1','CDP_PORT':'9222','CONTROLLER_PORT':'9223','CONTROLLER_REGISTRY_PATH':'/home/neko/.local/share/maw-controller/ownership.json','NEKO_MEMBER_MULTIUSER_USER_PROFILE':json.dumps({'is_admin':False,'can_login':True,'can_connect':True,'can_watch':True,'can_host':True,'can_share_media':False,'can_access_clipboard':False})}
envfile=root/'container.env';envfile.write_text('\n'.join(f'{k}={v}' for k,v in env.items()));envfile.chmod(0o600)
args=['docker','run','-d','--name',name,'--label','maw.audit=true','--shm-size','2gb','--security-opt',f'seccomp={repo}/infra/neko/config/seccomp.json','--env-file',str(envfile),'-p','127.0.0.1::8080','-p','127.0.0.1::9223','-p',f'127.0.0.1:{base}-{base+10}:{base}-{base+10}/udp']
for source,target in [('config/chromium.conf','/etc/neko/supervisord/chromium.conf'),('config/policies.json','/etc/chromium/policies/managed/policies.json'),('config/controller.conf','/etc/neko/supervisord/controller.conf'),('controller/tab_controller.py','/etc/neko/tab_controller.py'),('controller/ownership_registry.py','/etc/neko/ownership_registry.py'),('scripts/entrypoint.sh','/entrypoint-maw.sh')]:
    args+=['-v',str(repo/'infra/neko'/source)+':'+target+':ro']
# Profile and receipts live only in this new container's writable layer.
args+=['--entrypoint','/entrypoint-maw.sh','m1k1o/neko@sha256:9585af527274b594483af59fee8a97907cbde825c2865bf5e8ef6a8c4381e059','/usr/bin/supervisord','-c','/etc/neko/supervisord.conf']
for s in sockets:s.close()
subprocess.run(args,check=True,stdout=subprocess.DEVNULL)
ports=json.loads(subprocess.check_output(['docker','inspect','--format','{{json .NetworkSettings.Ports}}',name]))
url=lambda p:'http://127.0.0.1:'+ports[p+'/tcp'][0]['HostPort']
config=root/'maw-env.json';config.write_text(json.dumps({'NEKO_CONTROLLER_URL':url('9223'),'CONTROLLER_AUTH_TOKEN':token,'NEKO_VIEWER_URL':url('8080'),'NEKO_PASSWORD':password}));config.chmod(0o600)
print(config)
