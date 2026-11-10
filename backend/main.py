import asyncio
import contextlib
import ipaddress
import json
import logging
import os
import re
import secrets
import sqlite3
import time
from collections import deque
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .livebox import Livebox, LiveboxError, local_url, redact
from . import auth, database, operations, network, shares, control, user_profile, ssh_setup, workspace, accounts, servers, service_monitor
from .nat import normalize, normalize_section

ROOT = Path(__file__).resolve().parent.parent
DATA = Path(os.environ.get('ORANGE_DATA_DIR', ROOT / 'data'))
COOKIE = 'orange_session'
TTL = 8 * 3600
sessions = {}
attempts = {}
profile_lock = asyncio.Lock()
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(name)s %(message)s')
logging.getLogger('httpx').setLevel(logging.WARNING)
logging.getLogger('httpcore').setLevel(logging.WARNING)
logger = logging.getLogger('orange.api')


class StrictModel(BaseModel):
    model_config = ConfigDict(extra='forbid')


class Profile(StrictModel):
    name: str = Field(min_length=1, max_length=60)
    url: str = 'http://192.168.1.1'
    username: str = Field(default='admin', min_length=1, max_length=64)

    @field_validator('name', 'username')
    @classmethod
    def nonempty(cls, value):
        if not value.strip():
            raise ValueError('Valeur vide.')
        return value.strip()

    @field_validator('url')
    @classmethod
    def validate_url(cls, value):
        return local_url(value)


class Login(Profile):
    password: SecretStr = Field(min_length=1, max_length=256)


class Change(StrictModel):
    kind: Literal['wifi', 'wifi_config', 'wifi_radio', 'dhcp', 'port_add', 'port_delete']
    values: dict


class Confirm(StrictModel):
    token: str


@dataclass
class Session:
    box: Livebox
    name: str
    expires: float = field(default_factory=lambda: time.time() + TTL)
    history: deque = field(default_factory=lambda: deque(maxlen=360))
    events: deque = field(default_factory=lambda: deque(maxlen=300))
    pending: dict = field(default_factory=dict)
    snapshot: dict = field(default_factory=dict)
    previous: tuple | None = None
    interface: str | None = None
    devices: dict | None = None
    task: asyncio.Task | None = None
    refresh_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def event(self, message):
        self.events.appendleft({'time': time.time(), 'message': message, 'source': 'Livebox OS · observation locale'})
        try:
            database.record(message)
        except (OSError, sqlite3.Error):
            logger.warning('Unable to persist a network observation')


async def remove_session(key):
    session = sessions.pop(key, None)
    if session:
        session.pending.clear()
        if session.task:
            session.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await session.task
        await session.box.close()


async def reaper():
    while True:
        await asyncio.sleep(60)
        await network.cleanup()
        await shares.cleanup()
        await control.cleanup()
        for key, session in list(sessions.items()):
            if session.expires < time.time():
                await remove_session(key)
        for key in list(attempts):
            attempts[key] = [stamp for stamp in attempts[key] if stamp > time.time() - 60]
            if not attempts[key]:
                attempts.pop(key, None)


@asynccontextmanager
async def lifespan(app):
    cleanup = asyncio.create_task(reaper())
    services_task = asyncio.create_task(service_monitor.collect())
    yield
    cleanup.cancel()
    services_task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await services_task
    with contextlib.suppress(asyncio.CancelledError):
        await cleanup
    for key in list(sessions):
        await remove_session(key)
    for key in list(network.sessions):
        await network.disconnect(key)
    for key in list(shares.sessions):
        await shares.disconnect(key)
    await control.shutdown()


VERSION = '5.0.0'
app = FastAPI(title='Livebox OS', version=VERSION, docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h.strip() for h in os.environ.get('ORANGE_ALLOWED_HOSTS', 'localhost,127.0.0.1,[::1],testserver').split(',')])
app.include_router(auth.router)
app.include_router(control.router)
app.include_router(user_profile.router)
app.include_router(ssh_setup.router)
app.include_router(workspace.router)
app.include_router(accounts.router)
app.include_router(servers.router)
app.include_router(service_monitor.router)


@app.exception_handler(RequestValidationError)
async def validation_error(request, error):
    return JSONResponse({'detail': 'Paramètres invalides. Vérifiez les champs saisis.'}, status_code=422)


def origin_allowed(origin, host):
    if not origin:
        return False
    parsed = urlsplit(origin)
    return parsed.scheme in ('http', 'https') and parsed.netloc == host


@app.middleware('http')
async def protect(request: Request, call_next):
    started = time.monotonic()
    path = request.url.path
    public = path in ('/api/health', '/api/auth/state', '/api/auth/setup', '/api/auth/login', '/api/session')
    admin = auth.current(request)
    if path.startswith('/api/') and not public and not admin:
        return JSONResponse({'detail': 'Votre session Livebox OS a expiré. Identifiez-vous à nouveau.', 'code': 'APP_AUTH_REQUIRED'}, status_code=401)
    if admin and admin.role != 'admin' and path.startswith('/api/') and request.method not in ('GET', 'HEAD') and not public:
        own = path.startswith(('/api/user/', '/api/workspace')) or path in ('/api/login', '/api/logout', '/api/auth/logout', '/api/network/tplink/login', '/api/network/tplink/logout') or bool(re.fullmatch(r'/api/control/resources/[a-f0-9]{16}/(connect|disconnect)', path))
        docker_action = admin.role == 'operator' and bool(re.fullmatch(r'/api/servers/[a-f0-9]{16}/actions/(prepare|confirm)', path))
        if not own and not docker_action:
            return JSONResponse({'detail': 'Cette opération nécessite le rôle administrateur.'}, status_code=403)
    if path.startswith('/api/') and request.method not in ('GET', 'HEAD'):
        if not origin_allowed(request.headers.get('origin'), request.headers.get('host')):
            return JSONResponse({'detail': 'Origine non autorisée.'}, status_code=403)
        if not public and (not admin or not secrets.compare_digest(request.headers.get('x-csrf-token', ''), admin.csrf)):
            return JSONResponse({'detail': 'Protection CSRF : rechargez la page avant de réessayer.', 'code': 'CSRF_REQUIRED'}, status_code=403)
    length = request.headers.get('content-length', '')
    if length and (not length.isdigit() or int(length) > 23 * 1024 * 1024):
        return JSONResponse({'detail': 'La requête dépasse la taille autorisée.'}, status_code=413)
    request_id = secrets.token_hex(6)
    try:
        response = await call_next(request)
        if path == '/api/auth/logout' and response.status_code == 200:
            await control.cleanup(request.cookies.get(auth.COOKIE))
            await network.disconnect(request.cookies.get(auth.COOKIE))
            await shares.disconnect(request.cookies.get(auth.COOKIE))
            await remove_session(request.cookies.get(COOKIE))
    except Exception:
        logger.exception('request=%s method=%s route=%s failed', request_id, request.method, path.split('/profiles/')[0])
        response = JSONResponse({'detail': f'Erreur du serveur Livebox OS. Référence diagnostic : {request_id}.', 'code': 'SERVER_ERROR'}, status_code=500)
    if path.startswith('/api/'):
        logger.info('request=%s method=%s route=%s status=%s ms=%d', request_id, request.method, path.split('/profiles/')[0], response.status_code, (time.monotonic() - started) * 1000)
    response.headers['X-Request-ID'] = request_id
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Frame-Options'] = 'DENY'
    host = request.headers.get('host', '')
    sockets = f'ws://{host} wss://{host}' if re.fullmatch(r'[A-Za-z0-9.:\[\]-]+', host) else ''
    response.headers['Content-Security-Policy'] = f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' {sockets}; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    response.headers['Cache-Control'] = 'no-store' if request.url.path.startswith('/api/') else 'no-cache'
    return response


def authorized(request: Request):
    session = sessions.get(request.cookies.get(COOKIE))
    if not session or session.expires < time.time() or not session.box.auth_valid:
        raise HTTPException(401, {'message': 'La session Livebox est absente ou expirée. Reconnectez votre Livebox.', 'code': 'LIVEBOX_SESSION_EXPIRED'})
    return session


@app.get('/api/health')
async def health():
    return {'status': 'ok', 'application': 'Livebox OS', 'version': VERSION}


@app.get('/api/session')
async def session_info(request: Request):
    if not auth.current(request):
        return {'connected': False}
    session = sessions.get(request.cookies.get(COOKIE))
    if not session or session.expires < time.time() or not session.box.auth_valid:
        return {'connected': False}
    return {'connected': True, 'name': session.name, 'url': session.box.url}


@app.post('/api/login')
async def login(body: Login, request: Request, response: Response):
    host = request.client.host if request.client else 'local'
    recent = [t for t in attempts.get(host, []) if t > time.time() - 60]
    if len(recent) >= 5:
        raise HTTPException(429, 'Trop de tentatives. Réessayez dans une minute.')
    attempts[host] = recent + [time.time()]
    box = Livebox(body.url)
    try:
        await box.login(body.username, body.password.get_secret_value())
    except LiveboxError as error:
        await box.close()
        raise HTTPException(401, str(error))
    await remove_session(request.cookies.get(COOKIE))
    if len(sessions) >= 8:
        await box.close()
        raise HTTPException(429, 'Nombre maximal de sessions atteint.')
    key = secrets.token_urlsafe(32)
    session = Session(box, body.name)
    session.event('Session Livebox ouverte.')
    sessions[key] = session
    session.task = asyncio.create_task(collector(session))
    response.set_cookie(COOKIE, key, httponly=True, samesite='strict', secure=os.environ.get('ORANGE_COOKIE_SECURE') == '1' or request.url.scheme == 'https', max_age=TTL)
    return {'connected': True, 'name': body.name, 'url': box.url}


@app.post('/api/logout')
async def logout(request: Request, response: Response):
    await remove_session(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE)
    return {'connected': False}


def profiles_read():
    try:
        return json.loads((DATA / 'profiles.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return []
    except (ValueError, OSError):
        raise HTTPException(500, 'Impossible de lire les profils enregistrés.')


@app.get('/api/profiles')
async def get_profiles():
    return profiles_read()


async def profiles_write(items):
    DATA.mkdir(parents=True, exist_ok=True)
    temporary = DATA / 'profiles.tmp'
    temporary.write_text(json.dumps(items, ensure_ascii=False), encoding='utf-8')
    temporary.replace(DATA / 'profiles.json')


@app.post('/api/profiles')
async def save_profile(profile: Profile):
    async with profile_lock:
        items = [p for p in profiles_read() if p['name'] != profile.name]
        if len(items) >= 20:
            raise HTTPException(400, 'Maximum de 20 profils.')
        items.append(profile.model_dump())
        await profiles_write(items)
    return items


@app.delete('/api/profiles/{name}')
async def delete_profile(name: str):
    async with profile_lock:
        items = [p for p in profiles_read() if p['name'] != name]
        await profiles_write(items)
    return items


@app.put('/api/profiles/{name}')
async def update_profile(name: str, profile: Profile):
    async with profile_lock:
        items = profiles_read()
        if not any(p['name'] == name for p in items):
            raise HTTPException(404, 'Profil introuvable.')
        if profile.name != name and any(p['name'] == profile.name for p in items):
            raise HTTPException(409, 'Ce nom de profil existe déjà.')
        items = [profile.model_dump() if p['name'] == name else p for p in items]
        await profiles_write(items)
    return items


async def refresh(session, only_if_empty=False):
    async with session.refresh_lock:
        if only_if_empty and session.snapshot:
            return session.snapshot
        info, wan = await asyncio.gather(session.box.read('DeviceInfo', 'get'), session.box.read('NMC', 'getWANStatus', data=True))
        if not session.interface:
            interfaces = await session.box.read('HomeLan.Interface', 'get')
            candidates = interfaces['data'] if isinstance(interfaces['data'], dict) else {}
            for name in ('WAN_GPON', 'WAN_XGSPON', 'WAN_Ethernet'):
                session.interface = next((key for key, value in candidates.items() if re.fullmatch(r'[A-Za-z0-9_-]+', key) and isinstance(value, dict) and value.get('FriendlyName') == name), None)
                if session.interface:
                    break
        stats = await session.box.read(f'NeMo.Intf.{session.interface}', 'getNetDevStats') if session.interface else {'available': False, 'data': None, 'message': 'Non disponible : interface WAN non identifiée par HomeLan.'}
        now = time.time()
        down = up = None
        counters = stats['data']
        if stats['available'] and isinstance(counters, dict):
            rx, tx = counters.get('RxBytes'), counters.get('TxBytes')
            if isinstance(rx, (int, float)) and isinstance(tx, (int, float)):
                if session.previous:
                    stamp, old_rx, old_tx = session.previous
                    elapsed = now - stamp
                    if elapsed > 0 and rx >= old_rx and tx >= old_tx:
                        down, up = (rx - old_rx) * 8 / elapsed / 1e6, (tx - old_tx) * 8 / elapsed / 1e6
                session.previous = (now, rx, tx)
            else:
                session.previous = None
        else:
            session.previous = None
        session.history.append({'time': now, 'down': down, 'up': up})
        old_wan = session.snapshot.get('wan', {}).get('data')
        old_available = session.snapshot.get('info', {}).get('available')
        if old_available is not None and old_available != info['available']:
            session.event('Communication Livebox rétablie.' if info['available'] else 'Communication Livebox interrompue : vérifiez le réseau et l’alimentation.')
        if isinstance(old_wan, dict) and isinstance(wan['data'], dict) and old_wan.get('ConnectionState') != wan['data'].get('ConnectionState'):
            session.event(f"État WAN observé : {wan['data'].get('ConnectionState', 'Non disponible')}.")
        session.snapshot = {'info': info, 'wan': wan, 'stats': stats, 'interface': session.interface, 'rate': {'down': down, 'up': up}, 'updated': now}
        return session.snapshot


async def collector(session):
    count = 0
    while True:
        try:
            if count % 3 == 0:
                await session.box.check_session()
            if not session.box.auth_valid:
                session.event('Session Livebox expirée : reconnexion nécessaire.')
                session.expires = time.time()
                return
            await refresh(session)
        except Exception:
            logger.exception('collector failed; retrying without changing network settings')
            session.event('Lecture réseau interrompue ; nouvelle tentative automatique.')
            await asyncio.sleep(10)
            continue
        if count % 3 == 0:
            result = await session.box.read('Devices', 'get', {'expression': 'physical and !self and !voice'})
            if result['available'] and isinstance(result['data'], list):
                current = {d.get('Key', d.get('PhysAddress', d.get('Name', str(i)))): d for i, d in enumerate(result['data']) if isinstance(d, dict)}
                if session.devices is not None:
                    for key, device in current.items():
                        previous = session.devices.get(key, {})
                        if device.get('Active') != previous.get('Active'):
                            session.event(f"{device.get('Name', key)} : {'connecté' if device.get('Active') else 'déconnecté'} (état observé).")
                    for key, device in session.devices.items():
                        if key not in current and device.get('Active'):
                            session.event(f"{device.get('Name', key)} : absent de la liste des appareils.")
                session.devices = current
        count += 1
        await asyncio.sleep(10)


@app.get('/api/status')
async def status(session: Session = Depends(authorized)):
    if not session.snapshot:
        await refresh(session, only_if_empty=True)
    return session.snapshot | {'history': list(session.history)}


READS = {
    'devices': ('Devices', 'get', {'expression': 'physical and !self and !voice'}, False),
    'wifi': ('NMC.Wifi', 'get', {}, False),
    'wifi_config': ('NeMo.Intf.lan', 'getMIBs', {'mibs': 'wlanvap'}, False),
    'lan': ('NMC', 'getLANIP', {}, True),
    'dhcp': ('DHCPv4.Server', 'getDHCPServerPool', {}, False),
    'ports': ('Firewall', 'getPortForwarding', {}, False),
    'calls': ('VoiceService.VoiceApplication', 'getCallList', [{'line': '1'}], False),
    'logs': ('DHCPv4.Server.Stats', 'getDoraCyclesDetails', {}, False),
}


@app.get('/api/read/{section}')
async def read_section(section: str, session: Session = Depends(authorized)):
    if section not in READS:
        raise HTTPException(404, 'Service inconnu.')
    result = await session.box.read(*READS[section])
    if section == 'ports' and result['available']:
        try:
            result['data'] = normalize(result['data'])
        except ValueError as error:
            return {'available': False, 'data': None, 'message': str(error)}
    elif result['available']:
        result['data'] = normalize_section(result['data'], section)
    if result.get('code') == 'LIVEBOX_SESSION_EXPIRED':
        raise HTTPException(401, {'message': result['message'], 'code': result['code']})
    return result


@app.get('/api/events')
async def events(session: Session = Depends(authorized)):
    return list(session.events)


@app.get('/api/livebox/features/{section}')
async def livebox_feature(section: str, session: Session = Depends(authorized)):
    if section not in control.LB_READS:
        raise HTTPException(404, 'Lecture Livebox inconnue.')
    return await control.livebox_read(session.box, section)


def validate_change(change):
    value = change.values
    if change.kind == 'wifi_radio':
        if set(value) != {'interface', 'auto', 'channel'} or not isinstance(value['interface'], str) or not re.fullmatch(r'[A-Za-z0-9_-]+', value['interface']) or type(value['auto']) is not bool or type(value['channel']) is not int or not 0 <= value['channel'] <= 196:
            raise ValueError('Configuration radio invalide.')
        return value
    if change.kind == 'wifi':
        if set(value) != {'enabled'} or type(value['enabled']) is not bool:
            raise ValueError('État Wi-Fi invalide.')
        return value
    if change.kind == 'wifi_config':
        if set(value) != {'SSID', 'password'} or not isinstance(value['SSID'], str) or not 1 <= len(value['SSID'].encode('utf-8')) <= 32 or not isinstance(value['password'], str):
            raise ValueError('Nom de réseau invalide.')
        password = value['password']
        if password and not (8 <= len(password) <= 63 and password.isascii() and password.isprintable()):
            raise ValueError('Clé Wi-Fi invalide.')
        return value
    if change.kind == 'dhcp':
        if set(value) != {'Address', 'Netmask', 'DHCPEnable', 'DHCPMinAddress', 'DHCPMaxAddress'} or type(value['DHCPEnable']) is not bool:
            raise ValueError('Configuration DHCP incomplète.')
        address = ipaddress.IPv4Address(value['Address'])
        local_url(str(address))
        net = ipaddress.IPv4Network(f"{address}/{value['Netmask']}", strict=False)
        low, high = ipaddress.IPv4Address(value['DHCPMinAddress']), ipaddress.IPv4Address(value['DHCPMaxAddress'])
        if low not in net or high not in net or int(low) > int(high) or any(ip in (net.network_address, net.broadcast_address) for ip in (address, low, high)) or low <= address <= high:
            raise ValueError('Plage DHCP invalide ou contenant l’adresse de la Livebox.')
        return value | {'PrefixLength': net.prefixlen}
    if change.kind == 'port_add':
        if set(value) != {'id', 'internalPort', 'externalPort', 'destinationIPAddress', 'protocol', 'description'}:
            raise ValueError('Règle NAT/PAT incomplète.')
        if not isinstance(value['id'], str) or not 1 <= len(value['id']) <= 48 or not all(c.isalnum() or c in '-_' for c in value['id']):
            raise ValueError('Nom de règle invalide (lettres, chiffres, tirets).')
        if not isinstance(value['description'], str) or len(value['description']) > 128:
            raise ValueError('Description invalide.')
        if value['protocol'] not in ('6', '17', '6,17'):
            raise ValueError('Protocole invalide.')
        local_url(str(ipaddress.IPv4Address(value['destinationIPAddress'])))
        for key in ('internalPort', 'externalPort'):
            if type(value[key]) is not int or not 1 <= value[key] <= 65535:
                raise ValueError('Les ports doivent être compris entre 1 et 65535.')
        return value | {'enable': True, 'persistent': True, 'sourceInterface': 'data', 'origin': 'webui', 'destinationMACAddress': ''}
    if set(value) != {'id', 'destinationIPAddress', 'origin'} or value['origin'] != 'webui' or not isinstance(value['id'], str) or not 1 <= len(value['id']) <= 100:
        raise ValueError('Suppression de règle invalide.')
    local_url(str(ipaddress.IPv4Address(value['destinationIPAddress'])))
    return value


@app.post('/api/changes/prepare')
async def prepare(change: Change, session: Session = Depends(authorized)):
    try:
        values = validate_change(change)
    except (ValueError, TypeError, KeyError):
        raise HTTPException(422, 'Paramètres invalides : vérifiez les adresses, plages et ports.')
    if change.kind == 'wifi_config':
        config = await session.box.read('NeMo.Intf.lan', 'getMIBs', {'mibs': 'wlanvap'})
        data = config['data'] if isinstance(config['data'], dict) else {}
        vap = data.get('wlanvap', {})
        targets = [key for key, item in vap.items() if re.fullmatch(r'[A-Za-z0-9_-]+', key) and isinstance(item, dict) and isinstance(item.get('SSID'), str)] if isinstance(vap, dict) else []
        if not targets:
            raise HTTPException(409, 'Non disponible : interfaces Wi-Fi non identifiées.')
        values = values | {'interfaces': targets}
    if change.kind == 'wifi_radio':
        config = await session.box.read('NeMo.Intf.lan', 'getMIBs', {'mibs': 'wlanradio'})
        data = config['data'] if isinstance(config['data'], dict) else {}
        radio = data.get('wlanradio', {}).get(values['interface'], {})
        if not isinstance(radio, dict) or not isinstance(radio.get('AutoChannelEnable'), bool):
            raise HTTPException(409, 'Non disponible : interface radio non modifiable.')
        supported = radio.get('PossibleChannels', '')
        channels = {int(channel) for channel in (supported.split(',') if isinstance(supported, str) else supported or []) if str(channel).strip().isdigit()}
        if not values['auto'] and values['channel'] not in channels:
            raise HTTPException(422, 'Le canal choisi n’est pas déclaré compatible par la Livebox.')
    session.pending = {k: v for k, v in session.pending.items() if v['expires'] > time.time()}
    if len(session.pending) >= 10:
        raise HTTPException(429, 'Trop de modifications en attente.')
    token = secrets.token_urlsafe(24)
    session.pending[token] = {'kind': change.kind, 'values': values, 'expires': time.time() + 120}
    asyncio.get_running_loop().call_later(120, session.pending.pop, token, None)
    warnings = {'wifi': 'Le changement du Wi-Fi peut déconnecter vos appareils.', 'wifi_config': 'Le nom de réseau est appliqué à toutes les bandes du Wi-Fi principal. Le changement de nom ou de clé déconnecte les appareils sans fil.', 'wifi_radio': 'Le changement de canal peut interrompre temporairement les connexions de cette bande Wi-Fi.', 'dhcp': 'La modification du réseau peut interrompre tous les services. Si l’adresse change, reconnectez-vous à la nouvelle adresse.', 'port_add': 'Cette règle rend un service de votre réseau accessible depuis Internet.', 'port_delete': 'Cette suppression interrompt les connexions utilisant cette règle.'}
    return {'token': token, 'warning': warnings[change.kind], 'values': redact(values)}


@app.post('/api/changes/confirm')
async def confirm(body: Confirm, session: Session = Depends(authorized)):
    async with network.write_lock:
        return await apply_change(body, session)


async def apply_change(body, session):
    change = session.pending.pop(body.token, None)
    if not change or change['expires'] < time.time():
        raise HTTPException(409, 'Confirmation expirée ou déjà utilisée.')
    value, kind = change['values'], change['kind']
    try:
        if kind == 'wifi':
            enabled = value['enabled']
            await session.box.request('PowerManagement', 'setProfiles', {'profiles': [{'profile': 'WiFi', 'enable': enabled}]})
            await session.box.request('NMC.Wifi', 'set', {'Enable': enabled, 'Status': enabled})
        elif kind == 'wifi_config':
            config = {'SSID': value['SSID']}
            if value['password']:
                config['Security'] = {'KeyPassPhrase': value['password']}
            await session.box.request('NMC.Wifi', 'set', {'ConfigurationMode': False})
            await session.box.request('NeMo.Intf.lan', 'setWLANConfig', {'mibs': {'wlanvap': {key: config for key in value['interfaces']}}})
        elif kind == 'wifi_radio':
            radio = {'AutoChannelEnable': value['auto']}
            if not value['auto']:
                radio['Channel'] = value['channel']
            await session.box.request('NeMo.Intf.lan', 'setWLANConfig', {'mibs': {'wlanradio': {value['interface']: radio}}})
        elif kind == 'dhcp':
            await session.box.request('NetMaster.LAN.default.Bridge.lan', 'setIPv4', value)
        elif kind == 'port_add':
            await session.box.request('Firewall', 'setPortForwarding', value)
            await session.box.request('Firewall', 'commit')
        else:
            # LiveboxMonitor prefixes rule IDs with their origin when deleting.
            rule_id = value['id'] if value['id'].startswith('webui_') else f"webui_{value['id']}"
            await session.box.request('Firewall', 'deletePortForwarding', value | {'id': rule_id})
            await session.box.request('Firewall', 'commit')
    except LiveboxError as error:
        session.event(f'Modification {kind} : réponse de succès non reçue. Vérifiez l’état avant de réessayer.')
        raise HTTPException(502, f'{error} Une application partielle est possible ; actualisez avant de réessayer.')
    session.event(f'Modification {kind} acceptée par la Livebox.')
    return {'ok': True, 'message': 'Modification acceptée par la Livebox. Actualisez pour vérifier son état.'}


@app.websocket('/api/ws')
async def websocket(ws: WebSocket):
    session = sessions.get(ws.cookies.get(COOKIE))
    if not auth.current(ws) or not session or session.expires < time.time() or not origin_allowed(ws.headers.get('origin'), ws.headers.get('host')):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        while auth.current(ws) and session.expires >= time.time() and any(s is session for s in sessions.values()):
            await ws.send_json(session.snapshot | {'history': list(session.history), 'events': list(session.events)})
            await asyncio.sleep(10)
        await ws.close(code=1008)
    except (WebSocketDisconnect, RuntimeError):
        pass


app.include_router(operations.create_router(authorized, Profile, profiles_read, profiles_write))
app.include_router(network.create_router(authorized))
app.include_router(shares.router)


@app.get('/api/openapi.json', include_in_schema=False)
async def schema():
    return app.openapi()

dist = ROOT / 'frontend' / 'dist'
if dist.is_dir():
    app.mount('/assets', StaticFiles(directory=dist / 'assets'), name='assets')
    if (dist / 'hardware').is_dir():
        app.mount('/hardware', StaticFiles(directory=dist / 'hardware'), name='hardware')

    @app.get('/')
    async def index():
        return FileResponse(dist / 'index.html')

    @app.get('/orange-logo.png')
    async def logo():
        return FileResponse(dist / 'livebox-logo.svg')

    @app.get('/livebox-logo.svg')
    async def livebox_logo():
        return FileResponse(dist / 'livebox-logo.svg')
