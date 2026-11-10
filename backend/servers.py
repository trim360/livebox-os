import asyncio
import contextlib
import json
import re
import secrets
import time
from pathlib import PurePosixPath
from typing import Literal
from urllib.parse import urlsplit

import asyncssh
from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ConfigDict, Field

from . import accounts, auth, connectors, control, database

router = APIRouter(prefix='/api/servers', tags=['Linux administration'])
lock = asyncio.Lock()
limit = asyncio.Semaphore(4)
pending = {}
terminals = set()


class Policy(BaseModel):
    model_config = ConfigDict(extra='forbid')
    docker: bool = False
    terminal: bool = False
    roots: list[str] = Field(default_factory=list, max_length=8)


def policies():
    try:
        return json.loads((auth.DATA / 'server-policies.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}


def server(key):
    resource = control.get_resource(key)
    if resource['connector'] != 'ssh' or resource['username'].lower() == 'root':
        raise HTTPException(422, 'Un serveur SSH avec un compte non-root est requis.')
    return resource


def policy(key, capability=None):
    server(key)
    value = Policy(**policies().get(key, {}))
    if capability and not getattr(value, capability):
        raise HTTPException(403, 'Cette fonction doit être autorisée dans les permissions du serveur.')
    return value


@router.get('/{key}/policy')
async def get_policy(key: str):
    return policy(key)


@router.put('/{key}/policy')
async def put_policy(key: str, body: Policy, request: Request):
    actor = accounts.require(request, 'admin')
    server(key)
    if any(not p.startswith('/') or '..' in PurePosixPath(p).parts or p == '/' or '\x00' in p or len(p) > 512 for p in body.roots):
        raise HTTPException(422, 'Choisissez des dossiers absolus précis, jamais la racine /.')
    async with lock:
        values = policies()
        values[key] = body.model_dump()
        path = auth.DATA / 'server-policies.tmp'
        path.write_text(json.dumps(values), encoding='utf-8')
        path.chmod(0o600)
        path.replace(auth.DATA / 'server-policies.json')
    database.record(f'Permissions du serveur {key} modifiées par {actor.username}.', 'Livebox OS · audit')
    return body


async def ssh(key):
    resource = server(key)
    root = connectors.ssh_directory()
    identity = (root / resource['key_name']).resolve()
    if identity.parent != root or not identity.is_file() or not (root / 'known_hosts').is_file():
        raise HTTPException(409, 'Configurez la clé dédiée et l’identité du serveur dans Serveurs.')
    try:
        address = await connectors.resolve_host(resource['host'])
        return await asyncssh.connect(address, port=resource['port'], username=resource['username'],
            client_keys=[str(identity)], known_hosts=str(root / 'known_hosts'),
            host_key_alias=connectors.ssh_alias(resource), agent_path=None, config=None,
            password=None, preferred_auth='publickey', connect_timeout=8, login_timeout=8,
            keepalive_interval=10, keepalive_count_max=2)
    except (asyncssh.Error, OSError, ValueError):
        raise HTTPException(502, 'Connexion SSH refusée : vérifiez le compte, sa clé et l’empreinte du serveur.')


async def command(key, text, timeout=15):
    async with limit:
        async with await ssh(key) as connection:
            async with connection.create_process(text) as process:
                async def read(stream):
                    value = ''
                    while chunk := await stream.read(4096):
                        value += chunk
                        if len(value.encode()) > 128 * 1024:
                            raise HTTPException(502, 'Réponse trop volumineuse. Réduisez la lecture.')
                    return value
                try:
                    output, _ = await asyncio.wait_for(asyncio.gather(read(process.stdout), read(process.stderr)), timeout)
                    await asyncio.wait_for(process.wait_closed(), 3)
                except TimeoutError:
                    raise HTTPException(504, 'Le serveur n’a pas répondu dans le délai autorisé.')
                if process.exit_status != 0:
                    raise HTTPException(502, 'Commande indisponible ou droits insuffisants sur ce serveur.')
                return output


READS = {
    'identity': 'hostname; uname -sr; cat /etc/os-release',
    'metrics': connectors.SSH_COMMANDS['system'],
    'processes': 'ps -eo pid,user,pcpu,pmem,etime,comm --sort=-pcpu | head -n 101',
    'services': connectors.SSH_COMMANDS['services'],
    'logs': 'journalctl -n 150 --no-pager -o short-iso',
    'temperatures': 'for f in /sys/class/thermal/thermal_zone*/temp; do if test -r "$f"; then printf "%s " "$f"; cat "$f"; fi; done',
    'swap': "awk '/^Swap(Total|Free):/ {print}' /proc/meminfo",
    'docker-containers': "docker ps -a --no-trunc --format '{{json .}}'",
    'docker-stats': "docker stats --no-stream --no-trunc --format '{{json .}}'",
    'docker-images': "docker image ls --format '{{json .}}'",
    'docker-volumes': "docker volume ls --format '{{json .}}'",
    'docker-networks': "docker network ls --format '{{json .}}'",
    'docker-stacks': 'docker compose ls --all --format json',
}


@router.get('/{key}/read/{section}')
async def read(key: str, section: str, request: Request):
    if section == 'logs': accounts.require(request, 'admin', 'operator')
    policy(key, 'docker' if section.startswith('docker-') else None)
    if section not in READS:
        raise HTTPException(404, 'Lecture inconnue.')
    output = await command(key, READS[section])
    if section == 'metrics':
        data = connectors.linux_system(output)
    elif section.startswith('docker-'):
        try:
            data = json.loads(output) if section == 'docker-stacks' else [json.loads(line) for line in output.splitlines() if line]
        except ValueError:
            raise HTTPException(502, 'Réponse Docker non reconnue.')
    else:
        data = output
    return {'available': bool(output.strip()), 'data': data, 'measured_at': time.time(), 'message': None if output.strip() else 'Non disponible : aucune donnée retournée.'}


def container_id(value):
    if not re.fullmatch(r'[a-f0-9]{64}', value):
        raise HTTPException(422, 'Identifiant complet du conteneur requis.')
    return value


async def inspect(key, identifier):
    # Deliberately exclude environment, command arguments and mount source paths.
    output = await command(key, 'docker inspect --format ' + "'" + '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"status":{{json .State.Status}},"started":{{json .State.StartedAt}},"networks":{{json .NetworkSettings.Networks}}}' + "' " + container_id(identifier))
    value = json.loads(output)
    value['networks'] = list(value.get('networks', {}))
    return value


@router.get('/{key}/containers/{identifier}')
async def details(key: str, identifier: str):
    policy(key, 'docker')
    return await inspect(key, identifier)


@router.get('/{key}/containers/{identifier}/logs')
async def logs(key: str, identifier: str, request: Request):
    accounts.require(request, 'admin', 'operator')
    policy(key, 'docker')
    return {'data': await command(key, 'docker logs --tail 150 --timestamps ' + container_id(identifier) + ' 2>&1')}


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['start', 'stop', 'restart']
    container: str = Field(pattern=r'^[a-f0-9]{64}$')


class Confirmation(BaseModel):
    token: str = Field(max_length=100)
    phrase: str = Field(max_length=150)


@router.post('/{key}/actions/prepare')
async def prepare(key: str, body: Action, request: Request):
    accounts.require(request, 'admin', 'operator')
    policy(key, 'docker')
    before = await inspect(key, body.container)
    if before['name'].lstrip('/').startswith('orange-os-'):
        raise HTTPException(409, 'Utilisez le déploiement SSH pour les conteneurs de Livebox OS.')
    for token, value in list(pending.items()):
        if value['expires'] < time.time(): pending.pop(token, None)
    if len(pending) >= 64:
        raise HTTPException(429, 'Trop d’opérations en attente.')
    token = secrets.token_urlsafe(32)
    pending[token] = {'owner': control.admin_key(request), 'key': key, 'action': body.action, 'before': before, 'expires': time.time() + 90}
    return {'token': token, 'phrase': before['name'].lstrip('/'), 'before': before, 'action': body.action}


@router.post('/{key}/actions/confirm')
async def confirm(key: str, body: Confirmation, request: Request):
    actor = accounts.require(request, 'admin', 'operator')
    policy(key, 'docker')
    async with lock:
        value = pending.get(body.token)
        if not value or value['owner'] != control.admin_key(request) or value['key'] != key or value['expires'] < time.time():
            raise HTTPException(409, 'Confirmation expirée ou appartenant à une autre session.')
        if body.phrase != value['before']['name'].lstrip('/'):
            raise HTTPException(422, 'Recopiez le nom du conteneur.')
        pending.pop(body.token)
        before = await inspect(key, value['before']['id'])
        if before != value['before']:
            raise HTTPException(409, 'Le conteneur a changé depuis la préparation. Relisez son état.')
        database.record(f'Demande Docker {value["action"]} sur {before["id"][:12]} par {actor.username}.', 'Livebox OS · audit')
        await command(key, 'docker ' + value['action'] + ' ' + container_id(before['id']), timeout=45)
        after = await inspect(key, before['id'])
        expected = 'exited' if value['action'] == 'stop' else 'running'
        if after['status'] != expected:
            raise HTTPException(409, 'La commande a répondu mais l’état attendu n’est pas confirmé. Actualisez sans relancer automatiquement.')
        database.record(f'Action Docker {value["action"]} confirmée sur {before["id"][:12]}.', 'Livebox OS · audit')
        return after


@router.get('/{key}/files')
async def files(key: str, root: int = 0, path: str = ''):
    settings = policy(key)
    if root < 0 or root >= len(settings.roots) or path.startswith('/') or '..' in PurePosixPath(path).parts or '\x00' in path or len(path) > 1024:
        raise HTTPException(403, 'Dossier non autorisé.')
    async with asyncio.timeout(20), limit:
        async with await ssh(key) as connection:
            async with connection.start_sftp_client() as sftp:
                try:
                    base = PurePosixPath(await sftp.realpath(settings.roots[root]))
                    if str(base) == '/': raise HTTPException(403, 'La racine du serveur ne peut pas être exposée.')
                    target = PurePosixPath(await sftp.realpath(str(base / path)))
                    if not target.is_relative_to(base):
                        raise HTTPException(403, 'Ce lien sort du dossier autorisé.')
                    entries = []
                    async for entry in sftp.scandir(str(target)):
                        if entry.filename in ('.', '..'): continue
                        entries.append({'name': entry.filename, 'bytes': entry.attrs.size, 'modified': entry.attrs.mtime, 'directory': entry.attrs.type == asyncssh.FILEXFER_TYPE_DIRECTORY, 'symlink': entry.attrs.type == asyncssh.FILEXFER_TYPE_SYMLINK})
                        if len(entries) >= 500: break
                    return {'path': str(target.relative_to(base)), 'entries': entries, 'limit': 500}
                except asyncssh.SFTPError:
                    raise HTTPException(403, 'Dossier introuvable ou lecture refusée par le serveur.')


@router.websocket('/{key}/terminal')
async def terminal(ws: WebSocket, key: str):
    session = auth.current(ws)
    origin = urlsplit(ws.headers.get('origin', ''))
    if not session or session.role != 'admin' or origin.scheme not in ('http', 'https') or origin.netloc != ws.headers.get('host') or len(terminals) >= 4:
        await ws.close(code=1008)
        return
    await ws.accept()
    marker = secrets.token_hex(12)
    tasks = []
    try:
        policy(key, 'terminal')
        if len(terminals) >= 4: raise HTTPException(429, 'Limite des terminaux atteinte.')
        terminals.add(marker)
        async with await ssh(key) as connection:
            async with connection.create_process(term_type='xterm-256color', term_size=(100, 30)) as process:
                database.record(f'Terminal ouvert sur {key} par {session.username}.', 'Livebox OS · audit')
                async def outgoing():
                    while chunk := await process.stdout.read(4096):
                        await ws.send_json({'type': 'output', 'data': chunk})
                async def incoming():
                    while True:
                        raw = await ws.receive_text()
                        if len(raw) > 20000: raise ValueError()
                        message = json.loads(raw)
                        if not isinstance(message, dict): raise ValueError()
                        if message.get('type') == 'resize':
                            cols, rows = message.get('cols'), message.get('rows')
                            if type(cols) is not int or type(rows) is not int or not 10 <= cols <= 400 or not 2 <= rows <= 200: raise ValueError()
                            process.change_terminal_size(cols, rows)
                        elif message.get('type') == 'input' and isinstance(message.get('data'), str) and len(message['data']) <= 8192:
                            process.stdin.write(message['data'])
                            await process.stdin.drain()
                        else: raise ValueError()
                async def guard():
                    ticks = 0
                    while auth.current(ws) is session and policy(key).terminal:
                        await asyncio.sleep(2)
                        ticks += 1
                        if ticks % 15 == 0: await ws.send_json({'type': 'heartbeat'})
                tasks = [asyncio.create_task(fn()) for fn in (outgoing, incoming, guard)]
                await asyncio.wait(tasks, timeout=3600, return_when=asyncio.FIRST_COMPLETED)
    except (HTTPException, asyncssh.Error, OSError, ValueError, WebSocketDisconnect):
        with contextlib.suppress(Exception):
            await ws.send_json({'type': 'error', 'data': 'Session fermée ou connexion refusée. Vérifiez les permissions et reconnectez-vous explicitement.'})
    finally:
        for task in tasks: task.cancel()
        if tasks: await asyncio.gather(*tasks, return_exceptions=True)
        terminals.discard(marker)
        with contextlib.suppress(Exception): await ws.close()
