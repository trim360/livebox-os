import asyncio
import json
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from . import auth, database

router = APIRouter(prefix='/api/accounts', tags=['Accounts'])


def require(request, *roles):
    session = auth.current(request)
    if not session or session.role not in roles:
        raise HTTPException(403, 'Votre rôle ne permet pas cette opération.')
    return session


class NewAccount(auth.Credentials):
    role: Literal['viewer', 'operator'] = 'viewer'
    password: auth.SecretStr = Field(min_length=12, max_length=256)


@router.get('')
async def list_accounts(request: Request):
    require(request, 'admin')
    main = json.loads(auth.account_path().read_text(encoding='utf-8'))
    return [{'username': main['username'], 'role': 'admin'}] + [{'username': key, 'role': value['role'], 'disabled': value.get('disabled', False)} for key, value in auth.extra_accounts().items()]


@router.post('', status_code=201)
async def create(body: NewAccount, request: Request):
    actor = require(request, 'admin')
    async with auth.lock:
        existing = auth.extra_accounts()
        main = json.loads(auth.account_path().read_text(encoding='utf-8'))
        if body.username == main['username'] or body.username in existing or len(existing) >= 16:
            raise HTTPException(409, 'Compte déjà présent ou limite de 16 comptes atteinte.')
        existing[body.username] = {'role': body.role, 'hash': await asyncio.to_thread(auth.hasher.hash, body.password.get_secret_value())}
        temporary = auth.DATA / 'accounts.tmp'
        temporary.write_text(json.dumps(existing), encoding='utf-8')
        temporary.chmod(0o600)
        temporary.replace(auth.DATA / 'accounts.json')
    database.record(f'Compte {body.username} créé avec le rôle {body.role} par {actor.username}.', 'Livebox OS · audit')
    return {'username': body.username, 'role': body.role}


@router.patch('/{username}')
async def disable(username: str, disabled: bool, request: Request):
    actor = require(request, 'admin')
    async with auth.lock:
        values = auth.extra_accounts()
        if username not in values: raise HTTPException(404, 'Compte secondaire inconnu.')
        values[username]['disabled'] = disabled
        temporary = auth.DATA / 'accounts.tmp'
        temporary.write_text(json.dumps(values), encoding='utf-8')
        temporary.chmod(0o600)
        temporary.replace(auth.DATA / 'accounts.json')
        if disabled:
            for key, session in list(auth.sessions.items()):
                if session.username == username: auth.sessions.pop(key, None)
    database.record(f'Accès du compte {username} {"suspendu" if disabled else "rétabli"} par {actor.username}.', 'Livebox OS · audit')
    return {'disabled': disabled}
