import { useEffect, useRef, useState } from 'react';
import { api, text, type Result } from './api';
import { Feedback, useRemote, type Resource } from './ControlPanels';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { LinuxSystem } from './SSHSetup';

type Policy = { docker: boolean; terminal: boolean; roots: string[] };
type Row = Record<string, unknown>;

function ServerPolicy({ id }: { id: string }) {
  const state = useRemote<Policy>(`/servers/${id}/policy`), [value, setValue] = useState<Policy>({ docker: false, terminal: false, roots: [] });
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { if (state.data) setValue(state.data); }, [state.data]);
  return <details className="cc-form"><summary>Permissions de ce serveur</summary><Feedback {...state} /><p>Ces accès utilisent uniquement les droits du compte SSH configuré. L’accès au démon Docker peut donner des pouvoirs étendus sur l’hôte. Aucun sudo ni ajout à un groupe n’est effectué.</p><label className="cc-check"><input type="checkbox" checked={value.docker} onChange={e => setValue({ ...value, docker: e.target.checked })} />Autoriser les lectures et actions Docker confirmées</label><label className="cc-check"><input type="checkbox" checked={value.terminal} onChange={e => setValue({ ...value, terminal: e.target.checked })} />Autoriser un terminal interactif aux administrateurs Livebox OS</label><label>Dossiers consultables, un chemin absolu par ligne<textarea rows={3} value={value.roots.join('\n')} onChange={e => setValue({ ...value, roots: e.target.value.split('\n') })} /></label><button disabled={busy} onClick={async () => { setBusy(true); setError(''); setMessage(''); try { await api(`/servers/${id}/policy`, { ...value, roots: value.roots.map(s => s.trim()).filter(Boolean) }, 'PUT'); setMessage('Permissions enregistrées.'); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>Enregistrer les permissions</button><Feedback error={error} busy={busy} />{message && <p role="status">{message}</p>}</details>;
}

export function TerminalPanel({ id }: { id: string }) {
  const element = useRef<HTMLDivElement>(null), socket = useRef<WebSocket | null>(null), terminal = useRef<Terminal | null>(null);
  const [run, setRun] = useState(false), [status, setStatus] = useState('Session fermée. Vos commandes ne sont pas enregistrées par Livebox OS.');
  useEffect(() => {
    if (!run || !element.current) return;
    const term = new Terminal({ cursorBlink: false, scrollback: 2000, fontSize: 14, fontFamily: 'Consolas, monospace', theme: { background: '#0b111b', foreground: '#e3eaf5' } });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(element.current); fit.fit(); terminal.current = term;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/servers/${id}/terminal`); socket.current = ws;
    const resize = () => { if (!element.current?.offsetWidth) return; fit.fit(); if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows })); };
    const observer = new ResizeObserver(resize); observer.observe(element.current);
    ws.onopen = () => { setStatus('Connexion SSH en cours…'); resize(); term.focus(); };
    ws.onmessage = e => { try { const message = JSON.parse(e.data); if (message.type === 'output') { setStatus('Session interactive ouverte'); term.write(message.data); } else if (message.type === 'error') setStatus(message.data); } catch { setStatus('Réponse du terminal illisible.'); } };
    ws.onclose = () => { setStatus('Session terminée. Cliquez sur Reconnecter pour ouvrir une nouvelle session.'); setRun(false); };
    ws.onerror = () => setStatus('Terminal inaccessible : vérifiez votre session et les permissions du serveur.');
    const data = term.onData(value => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: value })); });
    return () => { observer.disconnect(); data.dispose(); ws.onclose = null; ws.close(); term.dispose(); terminal.current = null; socket.current = null; };
  }, [run, id]);
  return <section className="r-terminal"><p role="status">{status}</p><div className="cc-actions"><button onClick={() => setRun(!run)}>{run ? 'Fermer la session' : 'Connecter / Reconnecter'}</button><button disabled={!run} onClick={() => terminal.current?.clear()}>Effacer l’affichage</button></div><div ref={element} className="r-terminal-screen" aria-label="Terminal SSH interactif" /><p>Copier : sélection puis Ctrl+Maj+C. Coller : Ctrl+Maj+V. La reconnexion ouvre un nouveau shell ; aucun ordre n’est rejoué.</p></section>;
}

function Metrics({ id }: { id: string }) {
  const live = useRemote<Result>(`/servers/${id}/read/metrics`, 30000);
  const [hours, setHours] = useState(24);
  const history = useRemote<{ samples: { time: number; cpu_percent?: number; memory_used_bytes?: number; memory_total_bytes?: number }[]; source: string }>(`/control/history/${id}?hours=${hours}`, 30000);
  const samples = history.data?.samples || [], stride = Math.max(1, Math.ceil(samples.length / 500));
  const points = samples.filter((_, i) => i % stride === 0 || i === samples.length - 1);
  function path(memory: boolean) {
    let joined = false;
    return points.map((s, i) => { const n = memory ? s.memory_total_bytes && s.memory_used_bytes !== undefined ? s.memory_used_bytes / s.memory_total_bytes * 100 : null : s.cpu_percent;
      if (n == null || !Number.isFinite(n)) { joined = false; return ''; }
      const part = `${joined ? 'L' : 'M'}${i / Math.max(1, points.length - 1) * 600},${110 - Math.min(100, n)} `; joined = true; return part;
    }).join('');
  }
  return <section><Feedback {...live} />{live.data?.available && <LinuxSystem result={live.data} />}<h3>Historique CPU et RAM</h3><label>Période<select value={hours} onChange={e => setHours(Number(e.target.value))}>{[1, 6, 24, 72, 168].map(n => <option key={n} value={n}>{n} heures</option>)}</select></label><Feedback {...history} />{points.length > 1 ? <><svg className="r-chart" viewBox="0 0 600 120" role="img" aria-label="Historique CPU en bleu et RAM en cyan, de 0 à 100 %"><path className="chart-grid" d="M0 10H600 M0 60H600 M0 110H600" /><path className="chart-down" d={path(false)} /><path className="chart-up" d={path(true)} /></svg><p>CPU · RAM / 0–100 % · {new Date(points[0].time * 1000).toLocaleString()} – {new Date(points.at(-1)!.time * 1000).toLocaleString()}</p></> : <p>Historique non disponible. Connectez ce serveur dans Serveurs pour démarrer la collecte ; les mesures sont conservées sept jours.</p>}</section>;
}

function ReadPanel({ id, section }: { id: string; section: string }) {
  const state = useRemote<Result>(`/servers/${id}/read/${section}`, 30000);
  const [query, setQuery] = useState('');
  const value = typeof state.data?.data === 'string' ? state.data.data : JSON.stringify(state.data?.data || [], null, 2);
  return <section><div className="cc-actions"><label>Filtrer les lignes<input value={query} onChange={e => setQuery(e.target.value)} /></label><button disabled={state.busy} onClick={() => void state.load()}>Actualiser</button></div><Feedback {...state} />{state.data?.available ? <pre className="cc-data r-log">{value.split('\n').filter(line => line.toLocaleLowerCase().includes(query.toLocaleLowerCase())).join('\n')}</pre> : state.data && <p>{state.data.message || 'Non disponible'}</p>}</section>;
}

function Files({ id }: { id: string }) {
  const policy = useRemote<Policy>(`/servers/${id}/policy`), [root, setRoot] = useState(0), [path, setPath] = useState('');
  const state = useRemote<{ entries: { name: string; bytes: number; directory: boolean; symlink: boolean }[]; limit: number }>(`/servers/${id}/files?root=${root}&path=${encodeURIComponent(path)}`, 0, !!policy.data?.roots.length);
  return <section><Feedback {...policy} />{!policy.data?.roots.length ? <p>Autorisez un dossier précis dans les permissions de ce serveur pour le consulter.</p> : <><label>Dossier autorisé<select value={root} onChange={e => { setRoot(Number(e.target.value)); setPath(''); }}>{policy.data.roots.map((r, i) => <option key={i} value={i}>{r}</option>)}</select></label><div className="cc-actions"><button disabled={!path} onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>Dossier parent</button><span>/{path}</span></div><Feedback {...state} /><div className="table-wrap"><table><thead><tr><th>Nom</th><th>Type</th><th>Taille</th></tr></thead><tbody>{state.data?.entries.map(entry => <tr key={entry.name}><td>{entry.directory ? <button onClick={() => setPath([path, entry.name].filter(Boolean).join('/'))}>{entry.name}</button> : entry.name}</td><td>{entry.directory ? 'Dossier' : entry.symlink ? 'Lien' : 'Fichier'}</td><td>{entry.bytes ?? 'Non disponible'}</td></tr>)}</tbody></table></div><p>Lecture seule, {state.data?.limit || 500} entrées maximum. Les liens sont vérifiés côté serveur.</p></>}</section>;
}

function Docker({ id }: { id: string }) {
  const [tab, setTab] = useState('containers'), [selected, select] = useState('');
  const list = useRemote<Result>(`/servers/${id}/read/docker-${tab}`, 15000), stats = useRemote<Result>(`/servers/${id}/read/docker-stats`, 15000, tab === 'containers');
  const [detail, setDetail] = useState<Row>(), [logs, setLogs] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<{ token: string; phrase: string; action: string }>(), [phrase, setPhrase] = useState('');
  const [message, setMessage] = useState('');
  const rows: Row[] = Array.isArray(list.data?.data) ? list.data.data : [];
  const metrics: Row[] = Array.isArray(stats.data?.data) ? stats.data.data : [];
  async function job(fn: () => Promise<void>) { setBusy(true); setError(''); setMessage(''); try { await fn(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }
  const columns: Record<string, string[]> = { containers: ['Names', 'State', 'Status', 'Image', 'Networks'], images: ['Repository', 'Tag', 'Size'], volumes: ['Name', 'Driver'], networks: ['Name', 'Driver', 'Scope'], stacks: ['Name', 'Status', 'ConfigFiles'] };
  return <section><div className="tabs" role="tablist" aria-label="Docker">{Object.keys(columns).map(name => <button role="tab" aria-selected={name === tab} key={name} onClick={() => { setTab(name); select(''); setDetail(undefined); setLogs(''); setPrepared(undefined); }}>{({ containers: 'Conteneurs', images: 'Images', volumes: 'Volumes', networks: 'Réseaux', stacks: 'Stacks Compose' } as Record<string, string>)[name]}</button>)}</div><Feedback {...list} />{tab === 'containers' && <Feedback error={stats.error} busy={false} />}<Feedback error={error} busy={busy} />{message && <p role="status">{message}</p>}<div className="table-wrap"><table><thead><tr>{columns[tab].map(key => <th key={key}>{key}</th>)}{tab === 'containers' && <><th>CPU / RAM</th><th>Détails</th></>}</tr></thead><tbody>{rows.map((row, index) => { const metric = metrics.find(m => m.ID === row.ID || m.Container === row.ID); return <tr key={index}>{columns[tab].map(key => <td key={key}>{text(row[key])}</td>)}{tab === 'containers' && <><td>{metric ? `${metric.CPUPerc} · ${metric.MemUsage}` : 'Non disponible'}</td><td><button onClick={() => void job(async () => { const key = String(row.ID); select(key); setPrepared(undefined); setLogs(''); setDetail(await api(`/servers/${id}/containers/${key}`)); })}>Ouvrir</button></td></>}</tr>; })}</tbody></table></div>{list.data && !rows.length && <p>Aucun élément retourné par Docker.</p>}{detail && <section className="cc-detail"><h3>{text(detail.name)}</h3><dl className="cc-facts"><div><dt>État observé</dt><dd>{text(detail.status)}</dd></div><div><dt>Image</dt><dd>{text(detail.image)}</dd></div></dl><h4>Relations réseau déclarées par Docker</h4><div className="r-network-relations"><strong>{text(detail.name)}</strong>{(detail.networks as string[] || []).map(network => <span key={network}>↔ {network}</span>)}</div><div className="cc-actions"><button disabled={busy} onClick={() => void job(async () => setLogs((await api<{ data: string }>(`/servers/${id}/containers/${selected}/logs`)).data))}>Lire les journaux</button>{['start', 'stop', 'restart'].map(action => <button disabled={busy} key={action} onClick={() => void job(async () => { setPrepared(await api(`/servers/${id}/actions/prepare`, { action, container: selected })); setPhrase(''); })}>{({ start: 'Démarrer…', stop: 'Arrêter…', restart: 'Redémarrer…' } as Record<string, string>)[action]}</button>)}</div>{prepared && <div className="cc-confirm"><p>Confirmer « {prepared.action} » sur {prepared.phrase}. Cette action modifie un service actif.</p><label>Recopiez le nom du conteneur<input value={phrase} onChange={e => setPhrase(e.target.value)} /></label><button disabled={busy || phrase !== prepared.phrase} onClick={() => void job(async () => { const value = prepared; setPrepared(undefined); setDetail(await api(`/servers/${id}/actions/confirm`, { token: value.token, phrase })); await list.load(); setMessage('Commande exécutée et état du conteneur vérifié.'); })}>Confirmer cette action</button><button onClick={() => setPrepared(undefined)}>Annuler</button></div>}{logs && <pre className="cc-data r-log">{logs}</pre>}</section>}</section>;
}

export default function ServerCenter({ mode, openServers }: { mode: string; openServers: () => void }) {
  const resources = useRemote<Resource[]>('/control/resources', 30000), [chosen, choose] = useState(''), [section, setSection] = useState('metrics');
  const servers = resources.data?.filter(r => r.kind === 'server') || [], resource = servers.find(r => r.id === chosen) || servers[0];
  return <div className="v4-application r-admin"><div className="cc-heading"><h2>{({ docker: 'Docker Control Center', terminal: 'Terminal SSH', system: 'Informations système', processes: 'Processus Linux', logs: 'Centre des journaux', files: 'Explorateur Linux' } as Record<string, string>)[mode]}</h2><button onClick={openServers}>Configurer les serveurs</button></div><Feedback {...resources} />{servers.length ? <><label>Serveur<select value={resource?.id || ''} onChange={e => choose(e.target.value)}>{servers.map(s => <option key={s.id} value={s.id}>{s.name} · {s.username}@{s.host}</option>)}</select></label>{resource && <div key={resource.id}><ServerPolicy id={resource.id} />{mode === 'docker' ? <Docker id={resource.id} /> : mode === 'terminal' ? <TerminalPanel id={resource.id} /> : mode === 'files' ? <Files id={resource.id} /> : <>{mode === 'system' && <label>Informations<select value={section} onChange={e => setSection(e.target.value)}><option value="metrics">Ressources et historique</option><option value="identity">Identité et noyau</option><option value="services">Services actifs</option><option value="temperatures">Températures disponibles (millidegrés Celsius)</option><option value="swap">Swap (kio)</option></select></label>}{mode === 'system' && section === 'metrics' ? <Metrics id={resource.id} /> : <ReadPanel key={section} id={resource.id} section={mode === 'system' ? section : mode} />}</>}</div>}</> : <div className="empty-state"><h3>Ajoutez votre serveur Linux</h3><p>Une clé dédiée et une empreinte vérifiée sont nécessaires. Aucun socket Docker n’est exposé au navigateur.</p><button className="primary" onClick={openServers}>Ouvrir Serveurs</button></div>}</div>;
}

export function AccountsPanel() {
  const state = useRemote<{ username: string; role: string; disabled?: boolean }[]>('/accounts');
  const [form, setForm] = useState({ username: '', password: '', role: 'viewer' }), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  return <div className="v4-application r-admin"><h2>Comptes et permissions</h2><p>Administrateur : configuration et terminal. Opérateur : lectures et actions Docker confirmées. Lecteur : consultation et profil personnel.</p><Feedback {...state} /><ul>{state.data?.map(account => <li key={account.username}>{account.username} · {account.role}{account.role !== 'admin' && <button disabled={busy} onClick={async () => { if (!confirm(`${account.disabled ? 'Rétablir' : 'Suspendre'} l’accès de ${account.username} ?`)) return; setBusy(true); setError(''); try { await api(`/accounts/${encodeURIComponent(account.username)}?disabled=${!account.disabled}`, {}, 'PATCH'); await state.load(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>{account.disabled ? 'Rétablir l’accès' : 'Suspendre l’accès'}</button>}</li>)}</ul>{state.data && <form className="cc-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); const body = form; setForm({ ...form, password: '' }); try { await api('/accounts', body); await state.load(); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}><h3>Créer un compte</h3><label>Identifiant<input required pattern="[a-zA-Z0-9_.-]+" maxLength={64} value={form.username} onChange={e => setForm({ ...form, username: e.target.value })} /></label><label>Mot de passe (12 caractères minimum)<input required minLength={12} type="password" autoComplete="new-password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label><label>Rôle<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value })}><option value="viewer">Lecteur</option><option value="operator">Opérateur</option></select></label><button disabled={busy}>Créer le compte</button></form>}<Feedback error={error} busy={busy} /></div>;
}
