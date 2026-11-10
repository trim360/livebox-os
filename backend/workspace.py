import asyncio
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field

from . import user_profile

router = APIRouter(prefix='/api/workspace', tags=['Workspace'])
lock = asyncio.Lock()


class Widget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: Literal['internet', 'traffic', 'devices', 'server', 'events', 'services']
    size: Literal['small', 'wide', 'tall'] = 'small'
    hidden: bool = False


class Window(BaseModel):
    model_config = ConfigDict(extra='forbid')
    id: str = Field(pattern=r'^[a-z][a-z0-9-]{0,63}$')
    x: float = Field(ge=0, le=20000)
    y: float = Field(ge=0, le=20000)
    width: float = Field(ge=100, le=20000)
    height: float = Field(ge=100, le=20000)
    z: int = Field(ge=0, le=1000)
    minimized: bool = False
    maximized: bool = False


class Workspace(BaseModel):
    model_config = ConfigDict(extra='forbid')
    widgets: list[Widget] = Field(default_factory=lambda: [Widget(id=i, size='wide' if i in ('traffic', 'devices') else 'small') for i in ('internet', 'traffic', 'server', 'devices', 'events', 'services')], max_length=6)
    windows: list[Window] = Field(default_factory=list, max_length=40)
    theme: Literal['light', 'dark'] | None = None
    motion: Literal['performance', 'balanced', 'ultra'] = 'balanced'
    accent: Literal['blue', 'cyan', 'violet'] = 'blue'
    restore: bool = True
    history_hours: int = Field(default=24, ge=1, le=168)
    server: str = Field(default='', pattern=r'^([a-f0-9]{16})?$')


@router.get('')
async def read(request: Request):
    path = user_profile.directory(request) / 'workspace.json'
    try:
        return Workspace.model_validate_json(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return Workspace()


@router.put('')
async def save(body: Workspace, request: Request):
    if len({w.id for w in body.widgets}) != len(body.widgets) or len({w.id for w in body.windows}) != len(body.windows):
        raise HTTPException(422, 'Éléments dupliqués dans cet espace de travail.')
    async with lock:
        root = user_profile.directory(request)
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        path = root / 'workspace.tmp'
        path.write_text(body.model_dump_json(), encoding='utf-8')
        path.chmod(0o600)
        path.replace(root / 'workspace.json')
    return body
