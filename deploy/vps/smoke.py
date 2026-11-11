"""Run with server-local credentials; never prints authentication material."""
import base64, json, os, pathlib, urllib.request, urllib.error

base = os.environ.get('TEST_URL', 'http://172.18.0.1:4181')
lines = pathlib.Path('/etc/global-offramp/access.txt').read_text().splitlines()
values = dict(line.split(': ', 1) for line in lines)
authorization = 'Basic ' + base64.b64encode((values['Username'] + ':' + values['Password']).encode()).decode()
cookie = ''
def call(path, body=None, actor='admin-demo', extra=None):
    global cookie
    headers = {'Authorization': authorization, 'x-demo-actor': actor}
    if cookie: headers['Cookie'] = cookie
    if body is not None: headers.update({'Origin': 'https://bhcbtc.club', 'Content-Type': 'application/json'})
    if extra: headers.update(extra)
    req = urllib.request.Request(base + path, data=None if body is None else json.dumps(body).encode(), headers=headers)
    response = urllib.request.urlopen(req, timeout=20)
    if response.headers.get('Set-Cookie'): cookie = response.headers['Set-Cookie'].split(';')[0]
    return response.read(), response.headers

health = json.loads(call('/api/health')[0])
assert health['schemaReady'] and not health['volatile'] and not health['realExecutionEnabled']
assert '汇途' in call('/')[0].decode()
dashboard = json.loads(call('/api/dashboard')[0])
if os.environ.get('VERIFY_ONLY') != 'true':
    call('/api/demo/scenario', {'idempotencyKey': 'vps-deployment-smoke-v1'})
    data = json.loads(call('/api/receipts/upload', {'files': [{'fileName':'deployment-smoke.pdf', 'contentType':'application/pdf', 'dataBase64':base64.b64encode(b'%PDF-1.4 synthetic deployment smoke').decode()}], 'kind':'single'})[0])
    receipt_id = data['receipts'][0]['id']
    pathlib.Path('/var/lib/global-offramp/smoke-receipt-id').write_text(receipt_id)
else:
    receipt_id = pathlib.Path('/var/lib/global-offramp/smoke-receipt-id').read_text()
assert call('/api/receipts/' + receipt_id + '/download')[0] == b'%PDF-1.4 synthetic deployment smoke'
try:
    call('/api/receipts/' + receipt_id + '/download', actor='customer-demo')
    raise AssertionError('Customer unexpectedly downloaded private receipt')
except urllib.error.HTTPError as error: assert error.code == 403
try:
    call('/api/demo/scenario', {'idempotencyKey':'invalid-origin'}, extra={'Origin':'https://evil.invalid'})
    raise AssertionError('Foreign origin accepted')
except urllib.error.HTTPError as error: assert error.code == 403
before = json.loads(call('/api/dashboard')[0])
spoof = json.loads(call('/api/dashboard', extra={'oai-authenticated-user-id':'attacker'})[0])
assert [x['id'] for x in before['orders']] == [x['id'] for x in spoof['orders']]
assert len(before['orders']) >= 3
print(json.dumps({'status':'passed','orders':len(before['orders']),'receipt_download':'passed','customer_receipt_denied':True,'foreign_origin_denied':True,'identity_spoof_ignored':True,'persistent':True}))
