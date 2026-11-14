from pathlib import Path
import subprocess,secrets,json,os
root=Path('/opt/global-offramp/business/current')
def sql(statement,db='postgres'):
 p=subprocess.run(['docker','exec','-i','global-offramp-business-postgres','psql','-U','offramp_owner','-d',db,'-v','ON_ERROR_STOP=1','-Atq'],input=statement,text=True,capture_output=True)
 if p.returncode:raise RuntimeError('Live database setup failed; inspect privately')
 return p.stdout.strip()
assert sql("SELECT count(*) FROM pg_database WHERE datname='offramp_live'")=='0','Existing live database must be reviewed'
assert sql("SELECT count(*) FROM pg_roles WHERE rolname='offramp_live_app'")=='0','Existing live role must be reviewed'
password=secrets.token_hex(32)
sql("CREATE ROLE offramp_live_app LOGIN PASSWORD '"+password+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;")
sql('CREATE DATABASE offramp_live OWNER offramp_owner;')
sql('REVOKE ALL ON DATABASE offramp_live FROM PUBLIC; GRANT CONNECT ON DATABASE offramp_live TO offramp_live_app;')
# Fresh database only. Do not run legacy migrations against the existing sandbox.
for f in ['db-runtime.sql']+[f'db/migrations/{n}' for n in ['002_workspace.sql','003_route_drafts.sql','004_operator_customer_username.sql','005_multi_fiat.sql','006_provider_accounts.sql','007_partner_invites.sql','008_funding_security.sql']]:sql((root/f).read_text(),'offramp_live')
grants=(root/'deploy/workspace/grants.sql').read_text().replace(':"app_role"','"offramp_live_app"');sql(grants,'offramp_live')
p=Path('/etc/global-offramp/live');p.mkdir(mode=0o700,exist_ok=False)
for name in ['live-recipient-vault.key','live-account-security.key']:
 k=Path('/etc/global-offramp')/name;k.write_bytes(os.urandom(32));os.chmod(k,0o640);subprocess.run(['chown','root:offramp-workspace',str(k)],check=True)
content='\n'.join(['WORKSPACE_ORIGIN=https://bhcbtc.club','WORKSPACE_PORT=4183','WORKSPACE_HOST=172.18.0.1','WORKSPACE_DATABASE_URL=postgresql://offramp_live_app:'+password+'@127.0.0.1:55432/offramp_live','WORKSPACE_RECEIPT_DIR=/var/lib/global-offramp-live/receipts','WORKSPACE_CLIENT_DIR=/opt/global-offramp/business/current/sites-dist/client','WORKSPACE_FUNDS_MODE=live','WORKSPACE_ENABLE_SIMULATED_TOPUPS=false','WORKSPACE_ENABLE_REAL_DEPOSITS=false','WORKSPACE_PAYOUTS_PAUSED=true','WORKSPACE_SECURITY_KEY_FILE=/etc/global-offramp/live-account-security.key','WORKSPACE_RECIPIENT_KEY_FILE=/etc/global-offramp/live-recipient-vault.key','WORKSPACE_RECEIPT_SCANNING=true'])+'\n'
(p/'runtime.env').write_text(content);os.chmod(p/'runtime.env',0o600)
subprocess.run(['install','-d','-o','offramp-workspace','-g','offramp-workspace','-m','700','/var/lib/global-offramp-live','/var/lib/global-offramp-live/receipts'],check=True)
print('Isolated empty live database and private configuration prepared; real deposits and payouts remain disabled')
