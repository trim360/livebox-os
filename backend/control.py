import asyncio
import contextlib
import csv
import io
import json
import os
import re
import secrets
import socket
import time
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from . import auth, database, network
from .connectors import CATALOG, LB_READS, OpenWrt, SSH_COMMANDS, connect_router, livebox_read, resolve_host, run_bounded, ssh_read, unavailable
from .livebox import LiveboxError, redact
from .tplink import AX58

router = APIRouter(prefix='/api/control', tags=['Network control center'])
sessions = {}
pending = {}
login_attempts = {}
write_lock = asyncio.Lock()
diagnostic_limit = asyncio.Semaphore(2)


class Strict(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Resource(Strict):
    name: str = Field(min_length=1, max_length=60, pattern=r'^[^\x00-\x1f]+$')
    kind: Literal['router', 'server'] = 'router'
    connector: Literal['livebox', 'tplink', 'openwrt', 'ssh']
    host: str = Field(min_length=1, max_length=260)
    username: str = Field(default='admin', max_length=64, pattern=r'^[A-Za-z0-9_.-]+$')
    port: int = Field(default=22, ge=1, le=65535)
    key_name: str = Field(default='monitor', pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
    interval: int = Field(default=60, ge=30, le=3600)
    measure_ping: bool = False
    authorized: Literal[True]


class Login(Strict):
    password: SecretStr = Field(default='', max_length=256)


class Metadata(Strict):
    name: str = Field(min_length=1, max_length=60, pattern=r'^[^\x00-\x1f]+$')
    interval: int = Field(ge=30, le=3600)


class Rule(Strict):
    name: str = Field(min_length=1, max_length=80)
    resource: str = Field(pattern=r'^[a-f0-9]{16}$')
    event: Literal['unavailable', 'new_device', 'public_ip', 'cpu', 'memory', 'disk']
    threshold: float = Field(default=90, ge=1, le=100)
    enabled: bool = True


class DeviceNote(Strict):
    alias: str = Field(default='', max_length=60)
    favorite: bool = False
    category: str = Field(default='', max_length=40)


class Action(Strict):
    action: Literal['guest', 'firewall', 'reboot']
    enabled: bool | None = None
    level: Literal['Low', 'Medium', 'High'] | None = None


class Confirm(Strict):
    token: str = Field(max_length=100)
    phrase: str


class Diagnostic(Strict):
    resource: str = Field(pattern=r'^[a-f0-9]{16}$')
    test: Literal['ping', 'dns', 'tcp', 'traceroute']
    port: int = Field(default=443, ge=1, le=65535)


@dataclass
class Connection:
    resource: dict
    box: object = None
    cache: dict = field(default_factory=dict)
    updated: float = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    task: asyncio.Task | None = None


@contextlib.contextmanager
def db_open():
    db = database.connect()
    try:
        db.executescript('''
        CREATE TABLE IF NOT EXISTS service_samples (id INTEGER PRIMARY KEY, time REAL, resource TEXT, value TEXT);
        CREATE TABLE IF NOT EXISTS control_resources (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS control_rules (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS control_notes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS control_notifications (id INTEGER PRIMARY KEY, time REAL, resource TEXT, message TEXT, acknowledged INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS control_samples (id INTEGER PRIMARY KEY, time REAL, resource TEXT, value TEXT);
        ''')
        with db:
            yield db
    finally:
        db.close()


def all_items(table):
    with db_open() as db:
        return [json.loads(row[0]) | {'id': row[1]} for row in db.execute(f'SELECT value,id FROM {table}')]


def save_item(table, key, value):
    with db_open() as db:
        db.execute(f'INSERT OR REPLACE INTO {table}(id,value) VALUES(?,?)', (key, json.dumps(value)))


def get_resource(key):
    found = next((item for item in all_items('control_resources') if item['id'] == key), None)
    if not found:
        raise HTTPException(404, 'Équipement inconnu.')
    return found


def admin_key(request):
    return request.cookies.get(auth.COOKIE)


def get_connection(request, key):
    connection = sessions.get((admin_key(request), key))
    if not connection:
        raise HTTPException(409, 'Reconnectez cet équipement. Les secrets ne sont pas conservés sur disque.')
    return connection


async def disconnect(key):
    connection = sessions.pop(key, None)
    if connection:
        if connection.task:
            connection.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await connection.task
        if connection.box:
            await connection.box.close()
    for token, item in list(pending.items()):
        if item['key'] == key:
            pending.pop(token, None)


async def cleanup(owner=None):
    for key in list(sessions):
        admin = auth.sessions.get(key[0])
        if key[0] == owner or not admin or admin.expires <= time.time():
            await disconnect(key)
    for token, item in list(pending.items()):
        if item['expires'] <= time.time():
            pending.pop(token, None)
    for key, stamps in list(login_attempts.items()):
        recent = [stamp for stamp in stamps if stamp > time.time() - 60]
        if not recent or key[0] == owner or key[0] not in auth.sessions:
            login_attempts.pop(key, None)
        else:
            login_attempts[key] = recent


async def shutdown():
    for key in list(sessions):
        await disconnect(key)


def device_rows(connector, data):
    if connector == 'livebox':
        return network.lb_clients(data)
    if connector == 'tplink':
        return network.clients(data)
    return []


def summarize(resource, reads):
    def data(section):
        value = reads.get(section, {}).get('data')
        return value if isinstance(value, dict) else {}
    driver = resource['connector']
    info = data('info')
    wan = data('wan')
    devices = device_rows(driver, reads.get('devices' if driver == 'livebox' else 'status', {}).get('data'))
    primary = reads.get('system' if driver == 'ssh' else 'status' if driver == 'tplink' else 'info', {})
    value = {'reachable': primary.get('available', False), 'devices': devices, 'firmware': None, 'uptime': None, 'public_ip': None, 'model': None, 'internet': None}
    if driver == 'livebox':
        value.update(firmware=info.get('SoftwareVersion'), model=info.get('ProductClass'), uptime=info.get('UpTime'), public_ip=wan.get('IPAddress'), internet=wan.get('ConnectionState'))
    elif driver == 'tplink':
        status = data('status')
        value.update(firmware=data('firmware').get('firmware_version'), public_ip=status.get('wan_ipv4_ipaddr'), uptime=status.get('wan_ipv4_uptime'), model=data('firmware').get('model'))
    elif driver == 'openwrt':
        release = info.get('release')
        value.update(firmware=release.get('version') if isinstance(release, dict) else None, model=info.get('model'), uptime=data('system').get('uptime'))
    elif driver == 'ssh':
        output = reads.get('system', {}).get('data')
        if isinstance(output, dict):
            value.update(uptime=output.get('uptime_seconds'), model=output.get('os'))
            value.update(disk_percent=max((d.get('used_percent', 0) for d in output.get('disks', []) if isinstance(d.get('used_percent'), (int, float))), default=None))
            value.update(cpu_percent=output.get('cpu_percent'), memory_used_bytes=output.get('memory', {}).get('used_bytes'), memory_total_bytes=output.get('memory', {}).get('total_bytes'))
        if isinstance(output, str):
            match = re.search(r'UPTIME\s+([0-9.]+)', output)
            if match:
                value['uptime'] = float(match.group(1))
    return value


def ping_metrics(output):
    loss = re.search(r'(\d+(?:[.,]\d+)?)\s*%', output)
    average = re.search(r'(?:Average|Moyenne)\s*=\s*([0-9.,]+)\s*m', output, re.IGNORECASE)
    unix = re.search(r'(?:rtt|round-trip)[^=]*=\s*[0-9.]+/([0-9.]+)/', output)
    latency = (average or unix)
    return {'latency_ms': float(latency.group(1).replace(',', '.')) if latency else None,
            'packet_loss_percent': float(loss.group(1).replace(',', '.')) if loss else None}


async def ping_measurement(host):
    ip = await resolve_host(host)
    arguments = ['ping', '-n', '4', '-w', '2000', ip] if os.name == 'nt' else ['ping', '-n', '-c', '4', '-W', '2', ip]
    async with diagnostic_limit:
        code, output = await run_bounded(arguments, timeout=12)
    return {'available': True, 'ok': code == 0, 'data': output, **ping_metrics(output)}


def notify_changes(resource, before, after):
    if not before:
        return
    events = []
    if before['reachable'] and not after['reachable']:
        events.append(('unavailable', 'Équipement devenu inaccessible à la collecte.'))
    if before['reachable'] and after['reachable']:
        old = {d.get('mac') or d['ip'] for d in before['devices']}
        new = {d.get('mac') or d['ip'] for d in after['devices']}
        if new - old:
            events.append(('new_device', f'{len(new - old)} nouvel appareil observé par cet équipement.'))
        if before.get('public_ip') and after.get('public_ip') and before['public_ip'] != after['public_ip']:
            events.append(('public_ip', 'Adresse WAN modifiée entre deux observations.'))
    for rule in all_items('control_rules'):
        if not rule['enabled'] or rule['resource'] != resource['id']: continue
        messages = [message for event, message in events if rule['event'] == event]
        if rule['event'] == 'unavailable' and not before['reachable'] and after['reachable']:
            messages.append('Équipement de nouveau accessible.')
        field = {'cpu': 'cpu_percent', 'memory': 'memory_percent', 'disk': 'disk_percent'}.get(rule['event'])
        if field:
            def metric(value):
                if field == 'memory_percent':
                    total, used = value.get('memory_total_bytes'), value.get('memory_used_bytes')
                    return used / total * 100 if total and used is not None else None
                return value.get(field)
            old, new = metric(before), metric(after)
            threshold = rule.get('threshold', 90)
            if old is not None and new is not None:
                if old < threshold <= new: messages.append(f'Seuil {rule["event"]} dépassé : {new:.1f} % (seuil {threshold:g} %).')
                elif old >= threshold > new: messages.append(f'{rule["event"]} de nouveau sous le seuil : {new:.1f} %.')
        for message in messages:
            with db_open() as db:
                db.execute('INSERT INTO control_notifications(time,resource,message) VALUES(?,?,?)', (time.time(), resource['id'], f'{rule["name"]} : {message}'))
                db.execute('DELETE FROM control_notifications WHERE id NOT IN (SELECT id FROM control_notifications ORDER BY id DESC LIMIT 1000)')



async def refresh(connection):
    async with connection.lock:
        if time.time() - connection.updated < connection.resource['interval']:
            return connection.cache
        resource, box = connection.resource, connection.box
        connector = resource['connector']
        if connector == 'ssh':
            reads = {'system': await ssh_read(resource, 'system')}
        else:
            sections = ['info', 'wan', 'devices', 'wifi'] if connector == 'livebox' else ['status', 'network', 'firmware'] if connector == 'tplink' else ['info', 'system', 'network']
            results = await asyncio.gather(*(livebox_read(box, name) if connector == 'livebox' else box.read(name) for name in sections))
            reads = dict(zip(sections, results))
        summary = summarize(resource, reads)
        if resource.get('measure_ping'):
            host = urlsplit(resource['host'] if '://' in resource['host'] else 'http://' + resource['host']).hostname
            try:
                measurement = await ping_measurement(host)
                summary.update({k: measurement[k] for k in ('latency_ms', 'packet_loss_percent')})
            except (OSError, ValueError, TimeoutError):
                summary.update(latency_ms=None, packet_loss_percent=None)
        notify_changes(resource, connection.cache.get('summary'), summary)
        connection.updated = time.time()
        connection.cache = {'reads': reads, 'summary': summary, 'updated': connection.updated}
        with db_open() as db:
            # Persist metrics only; device lists, SSH output and credentials stay out of samples.
            sample = {k: summary.get(k) for k in ('reachable', 'uptime', 'internet', 'latency_ms', 'packet_loss_percent', 'cpu_percent', 'memory_used_bytes', 'memory_total_bytes', 'disk_percent')}
            db.execute('INSERT INTO control_samples(time,resource,value) VALUES(?,?,?)', (connection.updated, resource['id'], json.dumps(sample)))
            db.execute('DELETE FROM control_samples WHERE time < ? OR id NOT IN (SELECT id FROM control_samples ORDER BY id DESC LIMIT 20000)', (time.time() - 7 * 86400,))
        return connection.cache


async def collect(key, connection):
    try:
        while key in sessions:
            await asyncio.sleep(connection.resource['interval'])
            owner = auth.sessions.get(key[0])
            if not owner or owner.expires <= time.time():
                return
            try:
                await refresh(connection)
            except Exception:
                database.record('Collecte interrompue ; nouvel essai à l’intervalle configuré.', 'Livebox OS · monitoring')
    finally:
        if key in sessions and sessions[key] is connection:
            sessions.pop(key)
            if connection.box:
                await connection.box.close()


@router.get('/catalog')
async def catalog():
    return {'connectors': CATALOG, 'vpn': {name: 'Lecture SSH uniquement ; gestion des clients et configuration non disponibles.' for name in ('WireGuard', 'OpenVPN', 'Tailscale')}}


@router.get('/discovery')
async def discovery():
    candidates = []
    try:
        if os.name == 'nt':
            _, output = await run_bounded(['route', 'print', '-4'], 5)
            candidates = [match.group(1) for match in re.finditer(r'^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+([0-9.]+)', output, re.MULTILINE)]
        else:
            from pathlib import Path
            import ipaddress
            for line in Path('/proc/net/route').read_text().splitlines()[1:]:
                fields = line.split()
                if len(fields) >= 4 and fields[1] == '00000000' and int(fields[3], 16) & 2:
                    candidates.append(str(ipaddress.IPv4Address(int(fields[2], 16).to_bytes(4, 'little'))))
        from .connectors import allowed_ip
        candidates = sorted({allowed_ip(ip) for ip in candidates})
    except (OSError, ValueError, TimeoutError):
        candidates = []
    return {'candidates': candidates, 'source': 'Table de routage du backend, sans scan ni authentification réseau', 'message': 'Une passerelle peut être celle de Docker ou du VPN, sans être un routeur pris en charge.'}


@router.get('/resources')
async def resources(request: Request):
    return [item | {'connected': (admin_key(request), item['id']) in sessions, 'observation': sessions[(admin_key(request), item['id'])].cache if (admin_key(request), item['id']) in sessions else None} for item in all_items('control_resources')]


@router.post('/resources', status_code=201)
async def add_resource(body: Resource):
    if (body.kind == 'server') != (body.connector == 'ssh'):
        raise HTTPException(422, 'Sélectionnez SSH pour un serveur et un connecteur routeur pour un routeur.')
    if body.kind == 'server' and body.username.lower() == 'root':
        raise HTTPException(422, 'Utilisez un compte SSH dédié avec des permissions limitées.')
    if body.kind == 'server' and (body.key_name.lower().startswith('known_hosts') or body.key_name.lower().endswith(('.pub', '.tmp'))):
        raise HTTPException(422, 'Nom de clé réservé : choisissez un nom sans suffixe .pub/.tmp et ne commençant pas par known_hosts.')
    if len(all_items('control_resources')) >= 40:
        raise HTTPException(409, 'Limite de 40 équipements atteinte.')
    try:
        if body.connector == 'ssh':
            await resolve_host(body.host)
        else:
            from .connectors import resolve_url
            await resolve_url(body.host)
    except (ValueError, OSError, TimeoutError):
        raise HTTPException(422, 'Adresse non autorisée ou nom DNS non résolu. Vérifiez les réseaux autorisés côté serveur.')
    key = secrets.token_hex(8)
    value = body.model_dump(exclude={'authorized'})
    save_item('control_resources', key, value)
    database.record('Équipement ajouté au registre.', 'Livebox OS · administration')
    return value | {'id': key}


@router.put('/resources/{key}')
async def edit_metadata(key: str, body: Metadata):
    resource = get_resource(key)
    value = resource | body.model_dump()
    save_item('control_resources', key, {k: v for k, v in value.items() if k != 'id'})
    for session_key, connection in sessions.items():
        if session_key[1] == key:
            connection.resource = value
    return value


@router.delete('/resources/{key}')
async def delete_resource(key: str):
    get_resource(key)
    for session_key in list(sessions):
        if session_key[1] == key:
            await disconnect(session_key)
    with db_open() as db:
        db.execute('DELETE FROM control_resources WHERE id=?', (key,))
    return {'deleted': True, 'message': 'Profil local retiré. Aucune configuration réseau supprimée.'}


@router.post('/resources/{key}/connect')
async def connect(key: str, body: Login, request: Request):
    resource = get_resource(key)
    session_key = (admin_key(request), key)
    async with write_lock:
        stamps = [stamp for stamp in login_attempts.get(session_key, []) if stamp > time.time() - 60]
        if len(stamps) >= 3:
            raise HTTPException(429, 'Trois tentatives par minute maximum pour cet équipement. Attendez avant de réessayer.')
        login_attempts[session_key] = stamps + [time.time()]
        await disconnect(session_key)
        box = None
        try:
            if resource['connector'] != 'ssh':
                if not body.password.get_secret_value():
                    raise HTTPException(422, 'Mot de passe requis pour établir la session routeur.')
                box = await connect_router(resource, body.password.get_secret_value())
            connection = Connection(resource, box)
            await refresh(connection)
            if resource['connector'] == 'ssh' and not connection.cache['summary']['reachable']:
                raise HTTPException(502, connection.cache['reads']['system'].get('message', 'Lecture SSH impossible.'))
            sessions[session_key] = connection
            connection.task = asyncio.create_task(collect(session_key, connection))
            return connection.cache
        except (LiveboxError, ValueError, OSError, TimeoutError):
            if box:
                await box.close()
            raise HTTPException(502, 'Connexion refusée ou équipement inaccessible. Vérifiez le connecteur et les identifiants.')


@router.post('/resources/{key}/disconnect')
async def disconnect_resource(key: str, request: Request):
    await disconnect((admin_key(request), key))
    return {'connected': False}


@router.get('/resources/{key}/read/{section}')
async def read(key: str, section: str, request: Request):
    connection = get_connection(request, key)
    connector = connection.resource['connector']
    if connector == 'ssh' and section in SSH_COMMANDS:
        return await ssh_read(connection.resource, section)
    allowed = LB_READS if connector == 'livebox' else AX58.READS if connector == 'tplink' else OpenWrt.READS
    if section not in allowed:
        return unavailable('Non disponible : cette fonction n’est pas implémentée par ce connecteur.')
    result = await livebox_read(connection.box, section) if connector == 'livebox' else await connection.box.read(section)
    return result


@router.post('/resources/{key}/actions/prepare')
async def prepare(key: str, body: Action, request: Request):
    connection = get_connection(request, key)
    if connection.resource['connector'] != 'livebox':
        raise HTTPException(409, 'Non disponible : écriture réservée au connecteur Livebox.')
    if body.action == 'guest' and body.enabled is None or body.action == 'firewall' and body.level is None:
        raise HTTPException(422, 'Paramètre de modification manquant.')
    if body.action != 'guest' and body.enabled is not None or body.action != 'firewall' and body.level is not None:
        raise HTTPException(422, 'Paramètre incompatible avec cette opération.')
    section = 'guest' if body.action == 'guest' else 'firewall' if body.action == 'firewall' else 'info'
    before = await livebox_read(connection.box, section)
    if not before['available']:
        raise HTTPException(409, 'Non disponible : lecture préalable refusée, modification bloquée.')
    token = secrets.token_urlsafe(24)
    await cleanup()
    if sum(item['key'][0] == admin_key(request) for item in pending.values()) >= 10:
        raise HTTPException(429, 'Trop de confirmations en attente.')
    pending[token] = {'key': (admin_key(request), key), 'expires': time.time() + 120, 'action': body, 'before': before}
    return {'token': token, 'before': before, 'after': body.model_dump(exclude_none=True), 'phrase': connection.resource['name'], 'warning': 'Cette opération peut couper le réseau ou modifier sa protection. Saisissez le nom de cet équipement pour confirmer. La confirmation expire après deux minutes.'}


@router.post('/resources/{key}/actions/confirm')
async def confirm(key: str, body: Confirm, request: Request):
    async with network.write_lock:
        item = pending.pop(body.token, None)
        session_key = (admin_key(request), key)
        if not item or item['key'] != session_key or item['expires'] < time.time():
            raise HTTPException(409, 'Confirmation expirée ou déjà utilisée.')
        connection = get_connection(request, key)
        if body.phrase != connection.resource['name']:
            raise HTTPException(422, 'Nom de confirmation incorrect. Préparez à nouveau la modification.')
        change = item['action']
        section = 'guest' if change.action == 'guest' else 'firewall' if change.action == 'firewall' else 'info'
        current = await livebox_read(connection.box, section)
        if change.action != 'reboot' and current != item['before']:
            raise HTTPException(409, 'L’état a changé depuis la préparation. Relisez et préparez à nouveau.')
        operation = ('NMC.Guest', 'set', {'Enable': change.enabled}) if change.action == 'guest' else ('Firewall', 'setFirewallLevel', {'level': change.level}) if change.action == 'firewall' else ('NMC', 'reboot', {'reason': 'GUI_Reboot'})
        database.record(f'Action Livebox confirmée : {change.action}.', 'Livebox OS · audit')
        try:
            await connection.box.request(*operation)
        except LiveboxError:
            return {'status': 'unknown', 'message': 'Résultat non confirmé. La requête a pu être appliquée avant la perte de connexion. Ne réessayez pas sans vérifier l’équipement.'}
        if change.action == 'reboot':
            return {'status': 'requested', 'message': 'Redémarrage accepté par l’API. Fin du redémarrage non vérifiée.'}
        after = await livebox_read(connection.box, section)
        expected = change.enabled if change.action == 'guest' else change.level
        actual = after['data'].get('Enable') if change.action == 'guest' and isinstance(after['data'], dict) else after['data']
        return {'status': 'verified' if after['available'] and actual == expected else 'unknown', 'observation': after}


@router.get('/rules')
async def rules():
    return all_items('control_rules')


@router.post('/rules', status_code=201)
async def save_rule(body: Rule):
    get_resource(body.resource)
    if len(all_items('control_rules')) >= 100:
        raise HTTPException(409, 'Limite de 100 règles atteinte.')
    key = secrets.token_hex(8)
    save_item('control_rules', key, body.model_dump())
    return body.model_dump() | {'id': key}


@router.put('/rules/{key}')
async def update_rule(key: str, body: Rule):
    if not any(item['id'] == key for item in all_items('control_rules')):
        raise HTTPException(404, 'Règle inconnue.')
    get_resource(body.resource)
    save_item('control_rules', key, body.model_dump())
    return {'saved': True}


@router.post('/rules/{key}/test')
async def test_rule(key: str):
    rule = next((item for item in all_items('control_rules') if item['id'] == key), None)
    if not rule:
        raise HTTPException(404, 'Règle inconnue.')
    with db_open() as db:
        db.execute('INSERT INTO control_notifications(time,resource,message) VALUES(?,?,?)', (time.time(), rule['resource'], f'Test manuel de la règle : {rule["name"]}. Aucun événement réseau déclenché.'))
    return {'tested': True}


@router.get('/notifications')
async def notifications():
    with db_open() as db:
        db.row_factory = __import__('sqlite3').Row
        return [dict(row) for row in db.execute('SELECT * FROM control_notifications ORDER BY id DESC LIMIT 300')]


@router.post('/notifications/{key}/acknowledge')
async def acknowledge(key: int):
    with db_open() as db:
        db.execute('UPDATE control_notifications SET acknowledged=1 WHERE id=?', (key,))
    return {'acknowledged': True}


@router.get('/notes')
async def notes():
    return all_items('control_notes')


@router.put('/notes/{key}')
async def save_note(key: str, body: DeviceNote):
    if not re.fullmatch(r'[A-Za-z0-9:._-]{1,100}', key):
        raise HTTPException(422, 'Identifiant appareil invalide.')
    save_item('control_notes', key, body.model_dump())
    return {'saved': True}


@router.get('/history/{key}')
async def history(key: str, hours: int = 24, format: Literal['json', 'csv'] = 'json'):
    get_resource(key)
    if not 1 <= hours <= 168:
        raise HTTPException(422, 'Période autorisée : 1 à 168 heures.')
    with db_open() as db:
        items = [{'time': row[0], **json.loads(row[1])} for row in db.execute('SELECT time,value FROM control_samples WHERE resource=? AND time>? ORDER BY time LIMIT 20000', (key, time.time() - hours * 3600))]
    if format == 'csv':
        stream = io.StringIO()
        writer = csv.DictWriter(stream, fieldnames=['time', 'reachable', 'uptime', 'internet', 'latency_ms', 'packet_loss_percent', 'cpu_percent', 'memory_used_bytes', 'memory_total_bytes', 'disk_percent'])
        writer.writeheader()
        writer.writerows({k: "'" + v if isinstance(v, str) and v.startswith(('=', '+', '-', '@')) else v for k, v in item.items()} for item in items)
        return Response(stream.getvalue(), media_type='text/csv', headers={'Content-Disposition': 'attachment; filename="observations.csv"'})
    return {'samples': items, 'source': 'Collecte backend, session active uniquement', 'retention_days': 7}


@router.post('/diagnostics')
async def diagnostics(body: Diagnostic):
    resource = get_resource(body.resource)
    host = urlsplit(resource['host'] if '://' in resource['host'] else 'http://' + resource['host']).hostname
    try:
        ip = await resolve_host(host or '')
        async with diagnostic_limit:
            started = time.monotonic()
            if body.test == 'dns':
                data = {'addresses': [ip], 'hostname': host, 'note': 'Adresse IPv4 autorisée. Un nom DNS passe par le résolveur du backend ; une IPv4 saisie directement ne nécessite pas de requête DNS. Aucun changement DNS.'}
                code = 0
            elif body.test == 'tcp':
                _, writer = await asyncio.wait_for(asyncio.open_connection(ip, body.port), 5)
                writer.close()
                await writer.wait_closed()
                code, data = 0, {'port': body.port, 'note': 'Connexion TCP depuis le backend réussie. Accessibilité depuis Internet non testée.'}
            elif body.test == 'ping':
                arguments = ['ping', '-n', '4', '-w', '2000', ip] if os.name == 'nt' else ['ping', '-n', '-c', '4', '-W', '2', ip]
                code, output = await run_bounded(arguments, timeout=12)
                data = {'output': output, **ping_metrics(output)}
            else:
                args = ['tracert', '-d', '-h', '8', '-w', '1000', ip] if os.name == 'nt' else ['traceroute', '-n', '-m', '8', '-q', '1', '-w', '1', ip]
                code, data = await run_bounded(args, timeout=20)
        return {'available': True, 'ok': code == 0, 'data': data, 'time': time.time(), 'duration_ms': round((time.monotonic() - started) * 1000), 'source': 'Backend Livebox OS', 'target': ip}
    except FileNotFoundError:
        return unavailable('Non disponible : installez l’outil de diagnostic dans le backend.')
    except (OSError, TimeoutError, ValueError):
        return {'available': True, 'ok': False, 'data': None, 'message': 'Destination non autorisée, connexion refusée ou délai dépassé.'}
