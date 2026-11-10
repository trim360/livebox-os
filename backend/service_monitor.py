import asyncio
import contextlib
import json
import secrets
import ssl
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from . import auth, connectors, control

router = APIRouter(prefix='/api/services', tags=['Service monitoring'])
lock = asyncio.Lock()


class Service(BaseModel):
    model_config = ConfigDict(extra='forbid')
    name: str = Field(min_length=1, max_length=80, pattern=r'^[^\x00-\x1f]+$')
    url: str = Field(max_length=512)
    interval: int = Field(default=60, ge=30, le=3600)
    enabled: bool = True


def configured():
    try: return json.loads((auth.DATA / 'services.json').read_text(encoding='utf-8'))
    except FileNotFoundError: return {}


async def destination(url):
    value = urlsplit(url)
    if value.scheme not in ('http', 'https') or value.username or value.password or value.query or value.fragment or any(c.isspace() or ord(c) < 32 for c in url):
        raise ValueError('Adresse HTTP(S) sans identifiant, jeton ni paramètres requise.')
    ip = await connectors.resolve_host(value.hostname or '')
    return value, ip, value.port or (443 if value.scheme == 'https' else 80)


async def probe(url):
    writer = None
    start = time.monotonic()
    try:
        async with asyncio.timeout(8):
            parsed, ip, port = await destination(url)
            options = {'ssl': ssl.create_default_context(), 'server_hostname': parsed.hostname} if parsed.scheme == 'https' else {}
            reader, writer = await asyncio.open_connection(ip, port, limit=8192, **options)
            path = (parsed.path or '/').encode('ascii')
            host = parsed.netloc.encode('ascii')
            writer.write(b'HEAD ' + path + b' HTTP/1.1\r\nHost: ' + host + b'\r\nConnection: close\r\nUser-Agent: Livebox-OS-monitor\r\n\r\n')
            await writer.drain()
            line = await reader.readline()
            fields = line.split()
            if len(fields) < 2 or not fields[0].startswith(b'HTTP/') or not fields[1].isdigit(): raise ValueError()
            code = int(fields[1])
            if not 100 <= code <= 599: raise ValueError()
            return {'status': 'available' if 200 <= code < 400 else 'http_error', 'http_status': code, 'latency_ms': round((time.monotonic() - start) * 1000, 1)}
    except (OSError, ValueError, TimeoutError, UnicodeError):
        return {'status': 'unreachable', 'http_status': None, 'latency_ms': None}
    finally:
        if writer:
            writer.close()
            with contextlib.suppress(Exception):
                await asyncio.wait_for(writer.wait_closed(), 1)


def samples(key):
    with control.db_open() as db:
        return [{'time': row[0], **json.loads(row[1])} for row in db.execute('SELECT time,value FROM service_samples WHERE resource=? ORDER BY time DESC LIMIT 300', (key,))]


@router.get('')
async def read():
    return [value | {'id': key, 'samples': samples(key)} for key, value in configured().items()]


@router.post('', status_code=201)
async def create(body: Service):
    try: await destination(body.url)
    except (OSError, ValueError, TimeoutError): raise HTTPException(422, 'Adresse invalide ou hors des réseaux privés autorisés. Les URL avec identifiants ou paramètres sont refusées.')
    async with lock:
        values = configured()
        if len(values) >= 16: raise HTTPException(409, 'Limite de 16 services atteinte.')
        key = secrets.token_hex(8)
        values[key] = body.model_dump()
        save(values)
    return {'id': key}


def save(values):
    path = auth.DATA / 'services.tmp'
    path.write_text(json.dumps(values), encoding='utf-8')
    path.chmod(0o600)
    path.replace(auth.DATA / 'services.json')


@router.patch('/{key}')
async def toggle(key: str, enabled: bool):
    async with lock:
        values = configured()
        if key not in values: raise HTTPException(404, 'Service inconnu.')
        values[key]['enabled'] = enabled
        save(values)
    return {'enabled': enabled}


async def collect():
    while True:
        for key, value in configured().items():
            previous = samples(key)
            if not value['enabled'] or previous and time.time() - previous[0]['time'] < value['interval']: continue
            result = await probe(value['url'])
            with control.db_open() as db:
                db.execute('INSERT INTO service_samples(time,resource,value) VALUES(?,?,?)', (time.time(), key, json.dumps(result)))
                db.execute('DELETE FROM service_samples WHERE time<? OR id NOT IN (SELECT id FROM service_samples ORDER BY id DESC LIMIT 20000)', (time.time() - 7 * 86400,))
                if previous and previous[0]['status'] != result['status']:
                    message = {'available': 'de nouveau disponible', 'http_error': 'répond avec une erreur HTTP', 'unreachable': 'inaccessible (réseau, TLS ou réponse non reconnue)'}[result['status']]
                    db.execute('INSERT INTO control_notifications(time,resource,message) VALUES(?,?,?)', (time.time(), key, f'{value["name"]} : {message}.'))
        await asyncio.sleep(10)
