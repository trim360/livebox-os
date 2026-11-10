import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from backend import auth, control, database, main, servers

KEY = 'a' * 16
CONTAINER = 'b' * 64


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(auth, 'DATA', tmp_path)
    monkeypatch.setattr(database, 'DATA', tmp_path)
    auth.sessions.clear()
    auth.attempts.clear()
    servers.pending.clear()
    auth.sessions['admin'] = auth.AdminSession(username='alice', csrf='test-csrf')
    auth.sessions['viewer'] = auth.AdminSession(username='bob', csrf='test-csrf', role='viewer')
    auth.sessions['operator'] = auth.AdminSession(username='chris', csrf='test-csrf', role='operator')
    auth.account_path().write_text(json.dumps({'username': 'alice', 'hash': auth.hasher.hash(secrets.token_urlsafe(24))}), encoding='utf-8')
    control.save_item('control_resources', KEY, {'name': 'Fixture', 'kind': 'server', 'connector': 'ssh', 'username': 'monitor', 'host': '127.0.0.1', 'port': 22, 'key_name': 'fixture', 'interval': 30})
    with TestClient(main.app, headers={'Origin': 'http://testserver', 'X-CSRF-Token': 'test-csrf'}) as value:
        value.cookies.set(auth.COOKIE, 'admin')
        yield value


def test_workspace_persistence_isolation_and_validation(client):
    space = client.get('/api/workspace').json()
    space['widgets'].reverse()
    space['motion'] = 'performance'
    assert client.put('/api/workspace', json=space).status_code == 200
    assert client.get('/api/workspace').json() == space
    client.cookies.set(auth.COOKIE, 'viewer')
    assert client.get('/api/workspace').json()['motion'] == 'balanced'
    assert client.put('/api/workspace', json=space).status_code == 200
    space['widgets'][0] = space['widgets'][1]
    assert client.put('/api/workspace', json=space).status_code == 422
    assert client.put('/api/workspace', json={'windows': [{'id': 'x', 'x': -1}]}).status_code == 422
    assert client.put('/api/workspace', json={}, headers={'X-CSRF-Token': 'bad'}).status_code == 403


def test_account_roles_and_session(client):
    password = secrets.token_urlsafe(24)
    assert client.post('/api/accounts', json={'username': 'reader', 'password': password, 'role': 'viewer'}).status_code == 201
    assert 'hash' not in client.get('/api/accounts').text
    result = client.post('/api/auth/login', json={'username': 'reader', 'password': password})
    assert result.status_code == 200 and result.json()['role'] == 'viewer'
    client.headers['X-CSRF-Token'] = result.json()['csrf']
    assert client.get('/api/accounts').status_code == 403
    assert client.post('/api/control/resources', json={}).status_code == 403
    assert client.post(f'/api/servers/{KEY}/actions/prepare', json={'container': CONTAINER, 'action': 'stop'}).status_code == 403
    assert client.put('/api/workspace', json={}).status_code == 200
    reader_cookie = client.cookies.get(auth.COOKIE, domain='testserver.local')
    client.cookies.clear()
    client.cookies.set(auth.COOKIE, 'admin')
    client.headers['X-CSRF-Token'] = 'test-csrf'
    assert client.patch('/api/accounts/reader?disabled=true', json={}).status_code == 200
    assert reader_cookie not in auth.sessions
    assert client.post('/api/auth/login', json={'username': 'reader', 'password': password}).status_code == 401


def test_docker_confirm_bound_to_owner_state_and_single_use(client, monkeypatch):
    state = {'id': CONTAINER, 'name': '/fixture', 'status': 'running', 'image': 'fixture', 'started': 'one', 'networks': []}
    calls = []
    async def inspect(*args): return dict(state)
    async def command(key, cmd, **kwargs):
        calls.append(cmd)
        state['status'] = 'exited'
        return CONTAINER
    monkeypatch.setattr(servers, 'inspect', inspect)
    monkeypatch.setattr(servers, 'command', command)
    url = f'/api/servers/{KEY}'
    action = {'action': 'stop', 'container': CONTAINER}
    assert client.post(url + '/actions/prepare', json=action).status_code == 403
    assert client.put(url + '/policy', json={'docker': True}).status_code == 200
    prepared = client.post(url + '/actions/prepare', json=action).json()
    payload = {'token': prepared['token'], 'phrase': 'fixture'}
    client.cookies.set(auth.COOKIE, 'operator')
    assert client.post(url + '/actions/confirm', json=payload).status_code == 409
    client.cookies.set(auth.COOKIE, 'admin')
    assert client.post(url + '/actions/confirm', json=payload | {'phrase': 'wrong'}).status_code == 422
    state['started'] = 'changed'
    assert client.post(url + '/actions/confirm', json=payload).status_code == 409
    assert not calls
    prepared = client.post(url + '/actions/prepare', json=action).json()
    payload['token'] = prepared['token']
    assert client.post(url + '/actions/confirm', json=payload).json()['status'] == 'exited'
    assert calls == ['docker stop ' + CONTAINER]
    assert client.post(url + '/actions/confirm', json=payload).status_code == 409


def test_server_path_policies_and_terminal_denials(client):
    url = f'/api/servers/{KEY}'
    for root in ['/', '/tmp/../', 'relative']:
        assert client.put(url + '/policy', json={'roots': [root]}).status_code == 422
    assert client.put(url + '/policy', json={'roots': ['/tmp/fixture']}).status_code == 200
    assert client.get(url + '/files?path=../secret').status_code == 403
    assert client.get(url + '/files?root=-1').status_code == 403
    for origin, cookie in [('https://attacker.invalid', 'admin'), ('http://testserver', 'viewer')]:
        client.cookies.set(auth.COOKIE, cookie)
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect(url + '/terminal', headers={'Origin': origin}): pass


def test_threshold_notifications_only_on_transitions(client):
    control.save_item('control_rules', 'c' * 16, {'name': 'CPU', 'resource': KEY, 'event': 'cpu', 'threshold': 80, 'enabled': True})
    low = {'reachable': True, 'devices': [], 'cpu_percent': 40}
    high = low | {'cpu_percent': 90}
    resource = control.get_resource(KEY)
    control.notify_changes(resource, None, high)
    control.notify_changes(resource, low, high)
    control.notify_changes(resource, high, high)
    assert len(client.get('/api/control/notifications').json()) == 1
    control.notify_changes(resource, high, low)
    assert len(client.get('/api/control/notifications').json()) == 2


def test_real_ssh_key_and_host_verification(tmp_path, monkeypatch):
    import asyncio
    import asyncssh
    from fastapi import HTTPException

    async def exercise():
        identity = asyncssh.generate_private_key('ssh-ed25519')
        host = asyncssh.generate_private_key('ssh-ed25519')
        (tmp_path / 'fixture').write_bytes(identity.export_private_key('openssh'))
        class Server(asyncssh.SSHServer):
            def begin_auth(self, username): return True
            def public_key_auth_supported(self): return True
            def validate_public_key(self, username, key): return username == 'monitor' and key == identity.convert_to_public()
        async def process(p):
            if p.command == 'hostname':
                p.stdout.write('isolated-ssh-fixture\n')
                p.exit(0)
            else: p.exit(1)
        async with await asyncssh.create_server(Server, '127.0.0.1', 0, server_host_keys=[host], process_factory=process) as listener:
            port = listener.get_port()
            resource = {'host': '127.0.0.1', 'port': port, 'username': 'monitor', 'key_name': 'fixture'}
            monkeypatch.setattr(servers, 'server', lambda key: resource)
            monkeypatch.setattr(servers.connectors, 'ssh_directory', lambda: tmp_path)
            monkeypatch.setattr(servers.connectors, 'ssh_alias', lambda value: 'fixture-host')
            async def resolve(host): return '127.0.0.1'
            monkeypatch.setattr(servers.connectors, 'resolve_host', resolve)
            known = tmp_path / 'known_hosts'
            known.write_text('fixture-host ' + host.export_public_key().decode(), encoding='utf-8')
            assert (await servers.command(KEY, 'hostname')).strip() == 'isolated-ssh-fixture'
            with pytest.raises(HTTPException) as error:
                await servers.command(KEY, 'unavailable')
            assert error.value.status_code == 502
            wrong = asyncssh.generate_private_key('ssh-ed25519')
            known.write_text('fixture-host ' + wrong.export_public_key().decode(), encoding='utf-8')
            with pytest.raises(HTTPException) as error:
                await servers.command(KEY, 'hostname')
            assert error.value.status_code == 502
    asyncio.run(exercise())


def test_service_monitor_real_http_and_ssrf(monkeypatch):
    import asyncio
    from backend import service_monitor
    async def exercise():
        async def response(reader, writer):
            request = await reader.readuntil(b'\r\n\r\n')
            assert request.startswith(b'HEAD /health HTTP/1.1\r\n')
            writer.write(b'HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n')
            await writer.drain()
            writer.close()
            await writer.wait_closed()
        async with await asyncio.start_server(response, '127.0.0.1', 0) as listener:
            port = listener.sockets[0].getsockname()[1]
            url = f'http://127.0.0.1:{port}/health'
            assert (await service_monitor.probe(url))['status'] == 'unreachable'
            async def resolve(host): return '127.0.0.1'
            monkeypatch.setattr(service_monitor.connectors, 'resolve_host', resolve)
            result = await service_monitor.probe(url)
            assert result['http_status'] == 204 and result['status'] == 'available'
            assert result['latency_ms'] >= 0
            for bad in ['http://user:secret@host/', 'http://host/?token=x', 'file:///etc/passwd', 'http://host/\r\nInjected:yes']:
                with pytest.raises(ValueError): await service_monitor.destination(bad)
    asyncio.run(exercise())
