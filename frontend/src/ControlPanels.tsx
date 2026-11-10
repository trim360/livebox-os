import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { WindowVisibility } from './DesktopWindow';
import { api, text, duration, type Result } from './api';
import SSHSetup, { LinuxSystem } from './SSHSetup';

export type Resource = {
  id: string; name: string; kind: 'router' | 'server'; connector: string; host: string;
  username: string; port: number; key_name: string; interval: number; connected: boolean;
  observation?: { updated: number; reads: Record<string, Result>; summary: {
    reachable: boolean; devices: Device[]; firmware: unknown; model: unknown; uptime: unknown; latency_ms?: number | null; packet_loss_percent?: number | null;
  }};
};
type Device = { name: string; ip: string; mac?: string; connection?: string; router: string; active?: boolean };
type Catalog = { id: string; manufacturer: string; model?: string; method?: string; status: string; note?: string };
type Automation = { id: string; name: string; resource: string; event: string; enabled: boolean; threshold?: number };
type Note = { id: string; alias: string; favorite: boolean; category: string };

export function useRemote<T>(path: string, interval = 0, enabled = true) {
  const visible = useContext(WindowVisibility);
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    setBusy(true);
    try {
      const value = await api<T>(path, undefined, undefined, current.signal);
      if (!current.signal.aborted) { setData(value); setError(''); }
    } catch (e) { if (!current.signal.aborted) setError((e as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  }, [path]);
  useEffect(() => {
    if (!visible || !enabled) { controller.current?.abort(); setBusy(false); if (!enabled) { setData(undefined); setError(''); } return; }
    void load();
    const timer = interval ? setInterval(() => { if (!document.hidden) void load(); }, interval) : undefined;
    return () => { clearInterval(timer); controller.current?.abort(); };
  }, [load, interval, visible, enabled]);
  return { data, error, busy, load };
}

export function DataView({ path, title }: { path: string; title: string }) {
  const state = useRemote<Result>(path);
  return <section className="cc-section"><div className="cc-heading"><h2>{title}</h2><button onClick={() => void state.load()} disabled={state.busy}>Relire</button></div>
    <Feedback {...state} />
    {state.data && (state.data.available ? <pre className="cc-data">{typeof state.data.data === 'string' ? state.data.data : JSON.stringify(state.data.data, null, 2)}</pre> : <p className="cc-notice">{state.data.message || 'Non disponible : le firmware ne fournit pas cette information.'}</p>)}
  </section>;
}

export function Feedback({ error, busy }: { error: string; busy: boolean }) {
  return <>{busy && <p role="status">Lecture des données du backend…</p>}{error && <p className="cc-error" role="alert">{error}</p>}</>;
}

export function ResourcesPanel({ kind = 'router', onChange }: { kind?: 'router' | 'server'; onChange?: () => void }) {
  const state = useRemote<Resource[]>('/control/resources', 30000);
  const catalog = useRemote<{ connectors: Catalog[] }>('/control/catalog');
  const [selected, select] = useState('');
  const [adding, add] = useState(false);
  const [message, setMessage] = useState('');
  const [working, setWorking] = useState(false);
  const [jobError, setJobError] = useState(false);
  const [password, setPassword] = useState('');
  const [section, setSection] = useState('info');
  const [form, setForm] = useState({ name: '', host: '', connector: kind === 'server' ? 'ssh' : 'livebox', username: kind === 'server' ? 'monitor' : 'admin', port: 22, key_name: 'monitor', interval: 60, measure_ping: false, authorized: false });
  const [prepared, setPrepared] = useState<{ token: string; before: unknown; after: unknown; warning: string; phrase: string }>();
  const [phrase, setPhrase] = useState('');
  const [action, setAction] = useState('guest-on');
  const [gateways, setGateways] = useState<string[]>([]);
  const [editName, setEditName] = useState('');
  const [editInterval, setEditInterval] = useState(60);
  const resource = state.data?.find(item => item.id === selected);
  const list = state.data?.filter(item => item.kind === kind) || [];
  const driver = catalog.data?.connectors.find(item => item.id === form.connector);
  async function run(job: () => Promise<void>) {
    setWorking(true); setMessage(''); setJobError(false);
    try { await job(); await state.load(); onChange?.(); }
    catch (e) { setMessage((e as Error).message); setJobError(true); }
    finally { setWorking(false); }
  }
  const sections = resource?.connector === 'ssh' ? ['system', 'services', 'docker', 'wireguard', 'openvpn', 'tailscale'] : resource?.connector === 'openwrt' ? ['info', 'system', 'network'] : resource?.connector === 'tplink' ? ['status', 'network', 'wan', 'firmware', 'wifi2', 'wifi5', 'leases', 'ports'] : ['info', 'wan', 'lan', 'devices', 'wifi', 'guest', 'schedule', 'firewall', 'firewall6', 'ping', 'dmz', 'ports', 'dhcp', 'dyndns', 'reboots', 'calls'];
  return <div className="cc-section"><div className="cc-heading"><h2>{kind === 'server' ? 'Serveurs Linux' : 'Équipements enregistrés'}</h2><button onClick={() => { add(!adding); setMessage(''); }}>{adding ? 'Fermer l’assistant' : kind === 'server' ? 'Ajouter un serveur' : 'Ajouter un routeur'}</button></div>
    <Feedback {...state} />
    {message && <p role={jobError ? 'alert' : 'status'} className={jobError ? 'cc-error' : 'cc-notice'}>{message}</p>}
    {adding && <form className="cc-form" onSubmit={e => { e.preventDefault(); void run(async () => {
      const value = await api<Resource>('/control/resources', { ...form, kind });
      select(value.id); setSection(kind === 'server' ? 'system' : form.connector === 'tplink' ? 'status' : 'info'); add(false);
      setMessage('Profil enregistré. Testez maintenant sa connexion ; aucun mot de passe n’a été enregistré.');
    }); }}>
      <h3>{kind === 'server' ? 'Connexion par clé dédiée' : 'Assistant de connexion'}</h3>
      <p>Ajout manuel uniquement. Aucun balayage du réseau. Les noms DNS sont résolus et limités aux réseaux autorisés côté serveur.</p>
      {kind === 'router' && <><button type="button" disabled={working} onClick={() => void run(async () => { const result = await api<{ candidates: string[]; message: string }>('/control/discovery'); setGateways(result.candidates); setMessage(result.message); })}>Lire les passerelles du backend</button><div className="cc-actions">{gateways.map(ip => <button type="button" key={ip} onClick={() => setForm({ ...form, host: ip })}>Utiliser {ip}</button>)}</div></>}
      <div className="cc-fields">
        <label>Nom de l’équipement<input required maxLength={60} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
        <label>{kind === 'server' ? 'Adresse IP ou nom DNS' : 'Adresse HTTP(S), IP ou nom DNS'}<input required value={form.host} onChange={e => setForm({ ...form, host: e.target.value })} placeholder={kind === 'server' ? 'Nom DNS du serveur' : 'Adresse du routeur sur votre réseau'} /></label>
        {kind === 'router' && <label>Fabricant / connecteur<select value={form.connector} onChange={e => setForm({ ...form, connector: e.target.value })}>{catalog.data?.connectors.map(item => <option key={item.id} value={item.id}>{item.manufacturer}{item.status === 'unavailable' ? ' : non disponible' : ''}</option>)}</select></label>}
        {form.connector !== 'tplink' && <label>Compte de connexion<input required value={form.username} pattern="[A-Za-z0-9_.-]+" onChange={e => setForm({ ...form, username: e.target.value })} /></label>}
        {kind === 'server' && <><label>Port SSH<input type="number" min={1} max={65535} value={form.port} onChange={e => setForm({ ...form, port: Number(e.target.value) })} /></label><label>Nom de la clé dédiée côté backend<input required maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value={form.key_name} onChange={e => setForm({ ...form, key_name: e.target.value })} /></label></>}
        <label>Intervalle de collecte (secondes)<input type="number" min={30} max={3600} value={form.interval} onChange={e => setForm({ ...form, interval: Number(e.target.value) })} /></label>
      </div>
      {driver && <p>Modèle : {driver.model || 'Non disponible'}. Méthode : {driver.method || 'Non disponible'}. {driver.note}</p>}
      {kind === 'server' && <p>Après l’enregistrement, ouvrez la configuration SSH pour créer une clé dédiée et vérifier l’identité du serveur. Le compte doit exister sur le serveur et ne doit pas être root. Pour Tailscale, autorisez explicitement son sous-réseau via LIVEBOX_OS_ALLOWED_NETWORKS côté backend.</p>}
      <label className="cc-check"><input type="checkbox" required checked={form.authorized} onChange={e => setForm({ ...form, authorized: e.target.checked })} />Je suis autorisé à administrer cet équipement et à effectuer ces lectures.</label>
      <label className="cc-check"><input type="checkbox" checked={form.measure_ping} onChange={e => setForm({ ...form, measure_ping: e.target.checked })} />Mesurer la latence et la perte avec 4 requêtes ping à chaque collecte (facultatif).</label>
      <button className="cc-primary" disabled={working || kind === 'router' && driver?.status === 'unavailable'}>Enregistrer le profil</button>
    </form>}
    <div className="cc-equipment-list">{list.map(item => <button key={item.id} aria-pressed={selected === item.id} onClick={() => { select(item.id); setPassword(''); setPrepared(undefined); setSection(item.connector === 'ssh' ? 'system' : item.connector === 'tplink' ? 'status' : 'info'); }}>
      <strong>{item.name}</strong><span>{item.host}</span><small>{item.connector} · {item.connected ? item.observation?.summary.reachable ? 'Lecture réussie' : 'Collecte active, lecture indisponible' : 'À reconnecter'}</small>
    </button>)}</div>
    {!list.length && !state.busy && <p className="cc-empty">Aucun {kind === 'server' ? 'serveur' : 'routeur'} enregistré ici. Ajoutez son adresse pour tester un connecteur. Les connexions Livebox et TP-Link de la V3 restent accessibles dans leurs outils.</p>}
    {resource && <section className="cc-detail"><div className="cc-heading"><div><h3>{resource.name}</h3><p>{resource.host} · {resource.connector}</p></div><button disabled={working} onClick={() => {
      if (window.confirm(`Retirer le profil local « ${resource.name} » ? Ses règles réseau resteront intactes.`)) void run(async () => { await api(`/control/resources/${resource.id}`, undefined, 'DELETE'); select(''); });
    }}>Retirer ce profil…</button></div>
      <details onToggle={e => { if (e.currentTarget.open) { setEditName(resource.name); setEditInterval(resource.interval); } }}><summary>Modifier le nom et l’intervalle de collecte</summary><form className="cc-form" onSubmit={e => { e.preventDefault(); void run(async () => { await api(`/control/resources/${resource.id}`, { name: editName, interval: editInterval }, 'PUT'); setMessage('Nom et intervalle enregistrés. Aucun réglage réseau modifié.'); }); }}><div className="cc-fields"><label>Nom<input required maxLength={60} value={editName} onChange={e => setEditName(e.target.value)} /></label><label>Intervalle (secondes)<input type="number" min={30} max={3600} value={editInterval} onChange={e => setEditInterval(Number(e.target.value))} /></label></div><button disabled={working}>Enregistrer ces préférences</button></form></details>
      {resource.connector === 'ssh' && <SSHSetup key={resource.id} resource={resource} />}
      {!resource.connected ? <form className="cc-form" onSubmit={e => { e.preventDefault(); const secret = password; setPassword(''); void run(async () => { const result = await api<{ summary: { reachable: boolean } }>(`/control/resources/${resource.id}/connect`, { password: secret }); setMessage(result.summary.reachable ? 'Connexion et lecture réussies.' : 'Lecture non disponible. Vérifiez les droits et le diagnostic.'); }); }}>
        {kind === 'router' && <label>Mot de passe administrateur<input type="password" required value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>}
        <p>{kind === 'server' ? 'Le test utilise le compte, le port et la clé ci-dessus, avec vérification stricte de l’identité SSH. Une lecture Linux réussie ouvre la session.' : 'Le secret est envoyé au backend puis remplacé par une session temporaire. Reconnexion manuelle après expiration ou redémarrage.'}</p>
        <button disabled={working} className="cc-primary">{kind === 'server' ? 'Tester la connexion' : 'Tester et connecter'}</button>
      </form> : <>
        <dl className="cc-facts"><div><dt>{resource.connector === 'ssh' ? 'Système déclaré' : 'Modèle déclaré'}</dt><dd>{text(resource.observation?.summary.model)}</dd></div><div><dt>Firmware déclaré</dt><dd>{text(resource.observation?.summary.firmware)}</dd></div><div><dt>Uptime</dt><dd>{duration(resource.observation?.summary.uptime)}</dd></div><div><dt>Dernière collecte</dt><dd>{resource.observation?.updated ? new Date(resource.observation.updated * 1000).toLocaleString() : 'Non disponible'}</dd></div></dl>
        <div className="cc-actions"><button disabled={working} onClick={() => void run(async () => { await api(`/control/resources/${resource.id}/disconnect`, {}); })}>Déconnecter cette session</button></div>
        <label>Lecture disponible<select value={section} onChange={e => setSection(e.target.value)}>{sections.map(value => <option key={value}>{value}</option>)}</select></label>
        {resource.connector === 'ssh' && section === 'system' ? <LinuxSystem key={resource.id} resource={resource} /> : <DataView key={`${resource.id}/${section}`} title="Réponse de l’équipement" path={`/control/resources/${resource.id}/read/${section}`} />}
        {resource.connector === 'livebox' && <section className="cc-form"><h3>Opérations Livebox avec confirmation</h3><p>API étudiée dans LiveboxMonitor. La lecture préalable bloque l’opération si le firmware refuse le service. Aucun test d’écriture n’est exécuté automatiquement.</p>
          <label>Opération<select value={action} onChange={e => { setAction(e.target.value); setPrepared(undefined); }}><option value="guest-on">Activer le Wi-Fi invité</option><option value="guest-off">Désactiver le Wi-Fi invité</option><option value="firewall-High">Pare-feu IPv4 : élevé</option><option value="firewall-Medium">Pare-feu IPv4 : moyen</option><option value="firewall-Low">Pare-feu IPv4 : faible</option><option value="reboot">Redémarrer la Livebox</option></select></label>
          <button disabled={working} onClick={() => void run(async () => { const [name, value] = action.split('-'); setPrepared(await api(`/control/resources/${resource.id}/actions/prepare`, { action: name, ...(name === 'guest' ? { enabled: value === 'on' } : name === 'firewall' ? { level: value } : {}) })); setPhrase(''); })}>Lire l’état et préparer</button>
          {prepared && <div className="cc-confirm"><p>{prepared.warning}</p><pre className="cc-data">{JSON.stringify({ avant: prepared.before, après: prepared.after }, null, 2)}</pre><label>Saisir « {prepared.phrase} »<input value={phrase} onChange={e => setPhrase(e.target.value)} /></label><div className="cc-actions"><button onClick={() => setPrepared(undefined)}>Annuler</button><button disabled={working || phrase !== prepared.phrase} onClick={() => void run(async () => { const value = await api(`/control/resources/${resource.id}/actions/confirm`, { token: prepared.token, phrase }); setMessage(JSON.stringify(value)); setPrepared(undefined); })}>Confirmer cette modification</button></div></div>}
        </section>}
      </>}
    </section>}
    {kind === 'router' && <details className="cc-section"><summary>Compatibilité des fabricants</summary><ul>{catalog.data?.connectors.map(item => <li key={item.id}><strong>{item.manufacturer}</strong> : {item.model || 'Non disponible'} · {item.status === 'tested-v3' ? 'Matériel testé en V3, à revalider en V4' : item.status === 'protocol-tested' ? 'Protocole testé, matériel non testé' : 'Connecteur non disponible'}. {item.note}</li>)}</ul></details>}
  </div>;
}

export function Devices({ resources }: { resources: Resource[] }) {
  const topology = useRemote<{ devices: Device[] }>('/network/topology');
  const notes = useRemote<Note[]>('/control/notes');
  const [query, search] = useState('');
  const [filter, setFilter] = useState('all');
  const [message, setMessage] = useState('');
  const devices = [...(topology.data?.devices || []), ...resources.flatMap(r => (r.observation?.summary.devices || []).map(d => ({ ...d, router: r.name })))];
  const filtered = devices.filter(d => `${d.name} ${d.ip} ${d.mac || ''} ${d.router}`.toLowerCase().includes(query.toLowerCase()) && (filter === 'all' || filter === 'active' && d.active !== false || filter === 'favorite' && notes.data?.some(n => n.id === (d.mac || d.ip) && n.favorite)));
  async function save(device: Device, patch: Partial<Note>) {
    const key = device.mac || device.ip;
    const old = notes.data?.find(n => n.id === key);
    try { await api(`/control/notes/${encodeURIComponent(key)}`, { alias: old?.alias || '', favorite: old?.favorite || false, category: old?.category || '', ...patch }, 'PUT'); await notes.load(); setMessage('Annotation locale enregistrée.'); }
    catch (e) { setMessage((e as Error).message); }
  }
  return <section className="cc-section"><h2>Appareils observés</h2><p>Chaque ligne conserve sa source. Les alias, catégories et favoris sont propres à Livebox OS et ne modifient pas le routeur.</p><Feedback {...topology} /><div className="cc-fields"><label>Rechercher<input value={query} onChange={e => search(e.target.value)} type="search" /></label><label>Filtre<select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">Tous</option><option value="active">Présents ou sans état fourni</option><option value="favorite">Favoris</option></select></label></div>
    {message && <p role="status">{message}</p>}
    {!filtered.length && <p className="cc-empty">Aucun appareil correspondant. Connectez un routeur pour lire sa liste.</p>}
    <div className="cc-device-list">{filtered.map((d, i) => {
      const note = notes.data?.find(n => n.id === (d.mac || d.ip));
      return <article key={`${d.router}-${d.ip}-${i}`}><div><h3>{note?.alias || d.name}</h3><p>{d.ip} · {d.mac || 'MAC non fournie'}</p><p>{d.router} · {d.connection || 'Connexion non fournie'} · {d.active === false ? 'Absent' : d.active === true ? 'Présent' : 'Activité non fournie'}</p></div><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); void save(d, { alias: String(data.get('alias')), category: String(data.get('category')) }); }}><label>Alias local<input name="alias" maxLength={60} defaultValue={note?.alias || ''} /></label><label>Catégorie<input name="category" maxLength={40} defaultValue={note?.category || ''} /></label><div className="cc-actions"><button>Enregistrer</button><button type="button" aria-pressed={note?.favorite || false} onClick={() => void save(d, { favorite: !note?.favorite })}>{note?.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button></div></form></article>;
    })}</div><p className="cc-notice">QoS, blocage, Wake-on-LAN et réservations par appareil : non disponibles dans ce module. Les informations non retournées par le routeur ne sont pas déduites.</p></section>;
}

export function Automations({ resources }: { resources: Resource[] }) {
  const state = useRemote<Automation[]>('/control/rules');
  const [name, setName] = useState('');
  const [resource, setResource] = useState('');
  const [event, setEvent] = useState('unavailable');
  const [threshold, setThreshold] = useState(90);
  const [message, setMessage] = useState('');
  async function run(job: () => Promise<unknown>) { try { await job(); await state.load(); setMessage('Règle enregistrée ou test effectué.'); } catch (e) { setMessage((e as Error).message); } }
  return <section className="cc-section"><h2>Règles de notification</h2><p>Évaluées par le backend pendant une session de collecte active. Aucune modification automatique du réseau. L’absence de session n’est pas assimilée à une panne.</p><Feedback {...state} />{message && <p role="status">{message}</p>}
    <form className="cc-form" onSubmit={e => { e.preventDefault(); void run(() => api('/control/rules', { name, resource, event, threshold, enabled: true })); }}><div className="cc-fields"><label>Nom de la règle<input required maxLength={80} value={name} onChange={e => setName(e.target.value)} /></label><label>Équipement<select required value={resource} onChange={e => setResource(e.target.value)}><option value="">Choisir un équipement</option>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label>Événement<select value={event} onChange={e => setEvent(e.target.value)}><option value="unavailable">Équipement devenu inaccessible</option><option value="new_device">Nouvel appareil observé</option><option value="public_ip">Changement d’adresse WAN</option><option value="cpu">Seuil CPU</option><option value="memory">Seuil RAM</option><option value="disk">Seuil stockage</option></select></label>{["cpu", "memory", "disk"].includes(event) && <label>Seuil en %<input type="number" min="1" max="100" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>}</div><button className="cc-primary">Créer la règle</button></form>
    {!state.data?.length && <p className="cc-empty">Aucune règle créée. Les alertes restent dans cette application.</p>}
    {state.data?.map(rule => <article className="cc-row" key={rule.id}><div><h3>{rule.name}</h3><p>{resources.find(r => r.id === rule.resource)?.name || 'Équipement retiré'} · {rule.event} · {rule.enabled ? 'Activée' : 'Désactivée'}</p></div><div className="cc-actions"><button onClick={() => void run(() => api(`/control/rules/${rule.id}`, { name: rule.name, resource: rule.resource, event: rule.event, threshold: rule.threshold ?? 90, enabled: !rule.enabled }, 'PUT'))}>{rule.enabled ? 'Désactiver' : 'Activer'}</button><button onClick={() => void run(() => api(`/control/rules/${rule.id}/test`, {}))}>Tester la notification</button></div></article>)}
  </section>;
}

export function Notifications() {
  const state = useRemote<{ id: number; time: number; message: string; acknowledged: number }[]>('/control/notifications', 30000);
  const [error, setError] = useState('');
  return <section className="cc-section"><h2>Notifications locales</h2><Feedback error={error || state.error} busy={state.busy} />{!state.data?.length && !state.busy && <p className="cc-empty">Aucune notification enregistrée. Créez une règle dans Automatisations pour surveiller un équipement connecté.</p>}{state.data?.map(item => <article className="cc-row" key={item.id}><div><time>{new Date(item.time * 1000).toLocaleString()}</time><p>{item.message}</p></div><button disabled={!!item.acknowledged} onClick={async () => { try { await api(`/control/notifications/${item.id}/acknowledge`, {}); setError(''); await state.load(); } catch (e) { setError((e as Error).message); } }}>{item.acknowledged ? 'Acquittée' : 'Acquitter'}</button></article>)}</section>;
}

export function VPN({ resources }: { resources: Resource[] }) {
  const [server, setServer] = useState('');
  const [protocol, setProtocol] = useState('wireguard');
  return <section className="cc-section"><h2>VPN sur serveur Linux</h2><p>Lecture par SSH d’un serveur que vous administrez. La Livebox n’est pas utilisée comme serveur WireGuard.</p><div className="cc-fields"><label>Serveur connecté<select value={server} onChange={e => setServer(e.target.value)}><option value="">Choisir un serveur</option>{resources.filter(r => r.kind === 'server' && r.connected).map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label>Service<select value={protocol} onChange={e => setProtocol(e.target.value)}><option value="wireguard">WireGuard : trafic et derniers échanges</option><option value="openvpn">OpenVPN : unités systemd</option><option value="tailscale">Tailscale : état du démon</option></select></label></div>
    {server ? <DataView key={`${server}/${protocol}`} path={`/control/resources/${server}/read/${protocol}`} title="État fourni par le serveur" /> : <p className="cc-empty">Ajoutez et connectez un serveur dans Serveurs. Ses permissions déterminent les lectures disponibles.</p>}
    <p className="cc-notice">Création de clients, révocation, import, export et activation de tunnels : non disponibles. Les clés privées VPN ne sont jamais demandées ni lues par ces commandes.</p>
  </section>;
}

export function Diagnostics({ resources }: { resources: Resource[] }) {
  const [resource, setResource] = useState('');
  const [test, setTest] = useState('ping');
  const [port, setPort] = useState(443);
  const [result, setResult] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="cc-section"><h2>Diagnostic d’un équipement autorisé</h2><p>Mesures exécutées depuis le backend vers une seule adresse enregistrée. Un test TCP local ne prouve pas l’ouverture d’un port sur Internet.</p><form className="cc-form" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { setResult(await api('/control/diagnostics', { resource, test, port })); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}><div className="cc-fields"><label>Cible<select required value={resource} onChange={e => setResource(e.target.value)}><option value="">Choisir un équipement</option>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label>Test<select value={test} onChange={e => setTest(e.target.value)}><option value="ping">Ping (4 requêtes)</option><option value="dns">Résolution DNS du nom enregistré</option><option value="tcp">Connexion TCP</option><option value="traceroute">Traceroute (8 sauts maximum)</option></select></label>{test === 'tcp' && <label>Port TCP<input type="number" min={1} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></label>}</div><button disabled={busy} className="cc-primary">Exécuter le diagnostic</button></form><Feedback error={error} busy={busy} />{result != null && <pre className="cc-data" role="status">{JSON.stringify(result, null, 2)}</pre>}</section>;
}

export function History({ resources }: { resources: Resource[] }) {
  const [resource, setResource] = useState('');
  const [hours, setHours] = useState(24);
  return <section className="cc-section"><h2>Historique des collectes</h2><p>Disponibilité et uptime réellement observés, conservés pendant sept jours. Les périodes sans session ne sont pas des mesures de panne.</p><div className="cc-fields"><label>Équipement<select value={resource} onChange={e => setResource(e.target.value)}><option value="">Choisir un équipement</option>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label><label>Période<select value={hours} onChange={e => setHours(Number(e.target.value))}><option value={1}>1 heure</option><option value={24}>24 heures</option><option value={168}>7 jours</option></select></label></div>{resource && <><div className="cc-actions"><a href={`/api/control/history/${resource}?hours=${hours}&format=csv`} download>Exporter CSV</a><a href={`/api/control/history/${resource}?hours=${hours}`} download>Exporter JSON</a></div><HistoryData key={`${resource}/${hours}`} path={`/control/history/${resource}?hours=${hours}`} /></>}</section>;
}

function HistoryData({ path }: { path: string }) {
  const state = useRemote<{ samples: { time: number; reachable: boolean; uptime: number | null; latency_ms?: number | null; packet_loss_percent?: number | null }[] }>(path);
  const samples = state.data?.samples.slice(-120) || [];
  const measured = samples.filter(s => s.latency_ms != null);
  const max = Math.max(1, ...measured.map(s => s.latency_ms!));
  const first = samples[0]?.time || 0, span = Math.max(1, (samples.at(-1)?.time || 0) - first);
  return <><Feedback {...state} />{!samples.length && !state.busy && <p className="cc-empty">Aucune collecte sur cette période. Connectez cet équipement pour démarrer les observations.</p>}<div className="cc-history" aria-label="Historique de disponibilité, chaque barre correspond à une collecte">{samples.map((s, i) => <span key={i} className={s.reachable ? 'reachable' : ''} title={`${new Date(s.time * 1000).toLocaleString()} : ${s.reachable ? 'joignable' : 'non joignable'}`}>{s.reachable ? '✓' : '×'}</span>)}</div>
    {measured.length > 1 && <figure className="cc-latency"><figcaption>Latence moyenne des requêtes ping, en millisecondes. Maximum affiché : {max.toFixed(2)} ms. Les périodes sans mesure restent vides.</figcaption><svg viewBox="0 0 600 160" role="img" aria-label="Mesures réelles de latence ; valeurs détaillées ci-dessous">{measured.map((s, i) => <line key={i} x1={(s.time-first)/span*590+5} x2={(s.time-first)/span*590+5} y1={150} y2={150-s.latency_ms!/max*140} stroke="currentColor" strokeWidth="3" />)}</svg></figure>}
    {samples.slice(-10).reverse().map((s, i) => <p key={i}>{new Date(s.time * 1000).toLocaleString()} : {s.reachable ? 'Lecture réussie' : 'Lecture indisponible'} · uptime {duration(s.uptime)} · latence {s.latency_ms == null ? 'Non disponible' : `${s.latency_ms} ms`} · perte {s.packet_loss_percent == null ? 'Non disponible' : `${s.packet_loss_percent} %`}</p>)}</>;
}
