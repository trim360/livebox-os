import asyncio
import contextlib
import hashlib
import ipaddress
import json
import os
import secrets
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field, SecretStr

DATA = Path(os.environ.get('ORANGE_DATA_DIR', Path(__file__).resolve().parent.parent / 'data'))
COOKIE = 'orange_admin'
LIFETIME = 12 * 3600
hasher = PasswordHasher()
lock = asyncio.Lock()
sessions = {}
attempts = {}
router = APIRouter(prefix='/api/auth')


@dataclass
class AdminSession:
    username: str = ''
    role: str = 'admin'
    expires: float = field(default_factory=lambda: time.time() + LIFETIME)
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    pending: dict = field(default_factory=dict)


class Credentials(BaseModel):
    model_config = ConfigDict(extra='forbid')
    username: str = Field(min_length=1, max_length=64, pattern=r'^[a-zA-Z0-9_.-]+$')
    password: SecretStr = Field(min_length=1, max_length=256)


def pairing_record(request):
    cookie = request.cookies.get('orange_setup', '')
    identifier, _, secret = cookie.partition('.')
    if not re.fullmatch(r'[a-f0-9]{16}', identifier) or not secret:
        return None
    try:
        value = json.loads((DATA / f'pairing-{identifier}.json').read_text(encoding='utf-8'))
        if value['expires'] > time.time() and secrets.compare_digest(value['hash'], hashlib.sha256(secret.encode()).hexdigest()):
            return identifier, value
    except (OSError, ValueError, KeyError):
        pass
    return None


def first_setup_allowed(request):
    if os.environ.get('ORANGE_TRUST_PROXY') != '1' and setup_allowed(request):
        return True
    pairing = pairing_record(request)
    return bool(pairing and pairing[1].get('approved'))


def current(request):
    session = sessions.get(request.cookies.get(COOKIE))
    return session if session and session.expires > time.time() else None


def client_ip(request):
    host = request.client.host if request.client else ''
    if os.environ.get('ORANGE_TRUST_PROXY') == '1':
        try:
            if ipaddress.ip_address(host).is_private:
                host = request.headers.get('x-real-ip', host)
        except ValueError:
            pass
    return host


def setup_allowed(request):
    sources = {s.strip() for s in os.environ.get('ORANGE_SETUP_SOURCES', '127.0.0.1,::1').split(',')}
    host = client_ip(request)
    if host in sources:
        return True
    try:
        address = ipaddress.ip_address(host)
        return any(address in ipaddress.ip_network(source, strict=False) for source in sources)
    except ValueError:
        return False


def account_path():
    return DATA / 'account.json'


def extra_accounts():
    try:
        return json.loads((DATA / 'accounts.json').read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}


def issue(request, response, username, role='admin'):
    for key, value in list(sessions.items()):
        if value.expires <= time.time():
            sessions.pop(key, None)
    if len(sessions) >= 16:
        raise HTTPException(429, 'Trop de sessions Livebox OS ouvertes.')
    key = secrets.token_urlsafe(32)
    session = AdminSession(username=username, role=role)
    sessions[key] = session
    response.set_cookie(COOKIE, key, httponly=True, samesite='strict', secure=os.environ.get('ORANGE_COOKIE_SECURE') == '1' or request.url.scheme == 'https', max_age=LIFETIME)
    return {'authenticated': True, 'configured': True, 'csrf': session.csrf, 'role': session.role}


@router.get('/state')
async def state(request: Request, response: Response):
    session = current(request)
    configured = account_path().is_file()
    extra = {}
    if not configured and not first_setup_allowed(request):
        DATA.mkdir(parents=True, exist_ok=True)
        pairing = pairing_record(request)
        if not pairing:
            for path in DATA.glob('pairing-*.json'):
                with contextlib.suppress(OSError, ValueError, KeyError):
                    if json.loads(path.read_text())['expires'] <= time.time():
                        path.unlink()
            if len(list(DATA.glob('pairing-*.json'))) >= 32:
                raise HTTPException(429, 'Trop de demandes d’appairage. Réessayez dans dix minutes.')
            identifier, secret = secrets.token_hex(8), secrets.token_urlsafe(32)
            value = {'hash': hashlib.sha256(secret.encode()).hexdigest(), 'expires': time.time() + 600, 'approved': False}
            path = DATA / f'pairing-{identifier}.json'
            with path.open('x', encoding='utf-8') as target:
                json.dump(value, target)
            response.set_cookie('orange_setup', f'{identifier}.{secret}', httponly=True, samesite='strict', secure=os.environ.get('ORANGE_COOKIE_SECURE') == '1' or request.url.scheme == 'https', max_age=600)
            pairing = (identifier, value)
        extra['pairing_id'] = pairing[0]
    return {'configured': configured, 'authenticated': bool(session), 'setup_allowed': first_setup_allowed(request), **extra, **({'csrf': session.csrf, 'role': session.role} if session else {})}


def throttle(request):
    host, now = client_ip(request), time.time()
    for key in list(attempts):
        attempts[key] = [stamp for stamp in attempts[key] if stamp > now - 60]
        if not attempts[key]:
            attempts.pop(key)
    recent = attempts.get(host, [])
    if len(recent) >= 5:
        raise HTTPException(429, 'Trop de tentatives. Attendez une minute.')
    attempts[host] = recent + [now]


@router.post('/setup')
async def setup(body: Credentials, request: Request, response: Response):
    throttle(request)
    if not first_setup_allowed(request):
        raise HTTPException(403, 'Cet appareil doit être autorisé via SSH avant la création du compte Livebox OS.')
    if len(body.password.get_secret_value()) < 12:
        raise HTTPException(422, 'Choisissez un mot de passe Livebox OS d’au moins 12 caractères.')
    async with lock:
        if account_path().exists():
            raise HTTPException(409, 'Un compte Livebox OS existe déjà.')
        password_hash = await asyncio.to_thread(hasher.hash, body.password.get_secret_value())
        DATA.mkdir(parents=True, exist_ok=True)
        # Exclusive creation prevents a concurrent bootstrap from replacing the account.
        with account_path().open('x', encoding='utf-8') as target:
            json.dump({'username': body.username, 'hash': password_hash}, target)
        with contextlib.suppress(OSError):
            account_path().chmod(0o600)
    response.delete_cookie('orange_setup')
    return issue(request, response, body.username)


@router.post('/login')
async def login(body: Credentials, request: Request, response: Response):
    throttle(request)
    try:
        account = json.loads(account_path().read_text(encoding='utf-8'))
        if body.username != account['username']:
            extra = extra_accounts().get(body.username)
            if extra: account = extra | {'username': body.username}
        valid = await asyncio.to_thread(hasher.verify, account['hash'], body.password.get_secret_value())
        valid = valid and secrets.compare_digest(account['username'], body.username) and not account.get('disabled', False)
    except (FileNotFoundError, VerificationError, ValueError, KeyError):
        valid = False
    if not valid:
        raise HTTPException(401, 'Identifiant ou mot de passe Livebox OS incorrect.')
    return issue(request, response, body.username, account.get('role', 'admin'))


@router.post('/logout')
async def logout(request: Request, response: Response):
    session = sessions.pop(request.cookies.get(COOKIE), None)
    if session:
        session.pending.clear()
    response.delete_cookie(COOKIE)
    return {'authenticated': False}


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] != 'approve-pairing' or not re.fullmatch(r'[a-f0-9]{16}', sys.argv[2]):
        raise SystemExit('Usage: python -m backend.auth approve-pairing IDENTIFIANT_AFFICHE')
    if account_path().exists():
        raise SystemExit('Le compte existe déjà : appairage initial fermé.')
    path = DATA / f'pairing-{sys.argv[2]}.json'
    value = json.loads(path.read_text(encoding='utf-8'))
    if value['expires'] <= time.time():
        raise SystemExit('Demande expirée. Actualisez le navigateur.')
    value['approved'] = True
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value), encoding='utf-8')
    temporary.replace(path)
    print('Cet appareil est autorisé pour la première configuration jusqu’à expiration de sa demande (10 minutes maximum).')
