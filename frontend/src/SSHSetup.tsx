import { useRef, useState } from 'react';
import { api, duration, rec } from './api';
import { Feedback, useRemote, type Resource } from './ControlPanels';

type Configuration = { mode: 'managed' | 'external'; keys: { name: string; public_key: string; private_key_present: boolean }[] };
type HostKey = { public_key: string; fingerprint: string };

export default function SSHSetup({ resource }: { resource: Resource }) {
  const configuration = useRemote<Configuration>('/control/ssh/config');
  const [candidate, setCandidate] = useState<HostKey>();
  const [manualKey, setManualKey] = useState('');
  const [fingerprint, setFingerprint] = useState(''), [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const key = configuration.data?.keys.find(key => key.name === resource.key_name);
  const publicField = useRef<HTMLTextAreaElement>(null);
  async function run(job: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await job(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <details className="cc-form ssh-setup"><summary>Configurer l’authentification SSH par clé</summary><Feedback {...configuration} />
    <p>Compte distant : <strong>{resource.username}</strong>, port <strong>{resource.port}</strong>, clé backend : <strong>{resource.key_name}</strong>. Le navigateur ne reçoit jamais de clé privée.</p>
    {configuration.data?.mode === 'external' ? <p>Le dossier LIVEBOX_OS_SSH_DIR est géré sur l’hôte et reste inchangé. Préparez-y la clé indiquée et le fichier known_hosts vérifié. Pour le stockage intégré, démarrez le backend sans cette variable.</p> : <>
      {!key && <button type="button" disabled={busy} onClick={() => void run(async () => { await api('/control/ssh/keys', { name: resource.key_name }); await configuration.load(); setMessage('Clé dédiée créée. Installez sa partie publique sur le serveur avant de tester.'); })}>Créer la clé dédiée « {resource.key_name} »</button>}
      {key && <><label>Clé publique à installer dans le compte distant<textarea ref={publicField} readOnly rows={3} value={key.public_key} /></label><button type="button" onClick={async () => {
        try { if (!navigator.clipboard) throw new Error(); await navigator.clipboard.writeText(key.public_key); setMessage('Clé publique copiée.'); }
        catch { publicField.current?.focus(); publicField.current?.select(); setMessage('Texte sélectionné : utilisez Ctrl+C pour copier la clé publique.'); }
      }}>Copier la clé publique</button><p>Ajoutez cette ligne dans <code>~/.ssh/authorized_keys</code> du compte <strong>{resource.username}</strong> sur le serveur. Le dossier .ssh doit avoir les droits 700 et authorized_keys les droits 600. La clé privée reste dans le volume privé du backend.</p>{!key.private_key_present && <p role="alert">La partie privée de cette clé n’est pas disponible côté backend.</p>}</>}
      <h4>Vérifier l’identité du serveur</h4><p>La lecture suivante ne fait pas confiance à la clé reçue. Comparez son empreinte avec celle obtenue dans une console fiable du serveur :</p><pre className="cc-data">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</pre>
      <button type="button" disabled={busy} onClick={() => void run(async () => { setCandidate(await api<HostKey>(`/control/resources/${resource.id}/host-key`)); setFingerprint(''); setVerified(false); })}>Lire la clé d’hôte sans l’accepter</button>
      <details><summary>Saisir la clé d’hôte depuis une console fiable</summary><p>Si le réseau ou votre version d’OpenSSH empêche la lecture automatique, copiez uniquement le fichier public /etc/ssh/ssh_host_ed25519_key.pub depuis la console du serveur. Ne copiez jamais le fichier sans extension .pub.</p><label>Clé publique d’hôte vérifiée<textarea rows={3} value={manualKey} onChange={e => setManualKey(e.target.value)} placeholder="ssh-ed25519 AAAA…" /></label><button type="button" disabled={busy || !manualKey.trim()} onClick={() => void run(async () => { setCandidate(await api<HostKey>('/control/ssh/fingerprint', { public_key: manualKey })); setFingerprint(''); setVerified(false); })}>Préparer cette clé publique</button></details>
      {candidate && <><p>Empreinte reçue, non vérifiée : <code>{candidate.fingerprint}</code></p><label>Empreinte vérifiée depuis la console du serveur<input autoComplete="off" value={fingerprint} onChange={e => setFingerprint(e.target.value)} placeholder="SHA256:…" /></label><label className="cc-check"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />J’ai comparé cette empreinte avec la console du serveur.</label><button type="button" disabled={busy || !verified || !fingerprint.trim()} onClick={() => void run(async () => { await api(`/control/resources/${resource.id}/host-key`, { public_key: candidate.public_key, fingerprint, verified }, 'PUT'); setMessage('Identité du serveur enregistrée. Vous pouvez tester la connexion.'); setCandidate(undefined); })}>Enregistrer l’identité vérifiée</button></>}
    </>}
    <Feedback error={error} busy={busy} />{message && <p role="status">{message}</p>}
  </details>;
}

function bytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Non disponible';
  const index = Math.min(3, Math.floor(Math.log(Math.max(1, value)) / Math.log(1024)));
  return `${(value / 1024 ** index).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${['o', 'Kio', 'Mio', 'Gio'][index]}`;
}

export function LinuxSystem({ resource, result }: { resource?: Resource; result?: { available: boolean; data: unknown; message?: string } }) {
  const remote = useRemote<{ available: boolean; data: unknown; message?: string }>(`/control/resources/${resource?.id}/read/system`, 30000, !!resource);
  const state = result ? { ...remote, data: result } : remote;
  const system = rec(state.data?.data), memory = rec(system.memory);
  const disks = Array.isArray(system.disks) ? system.disks.map(rec) : [], interfaces = Array.isArray(system.interfaces) ? system.interfaces.map(rec) : [];
  return <section className="cc-section"><div className="cc-heading"><h3>Informations Linux mesurées</h3>{resource && <button disabled={state.busy} onClick={() => void state.load()}>Actualiser le serveur</button>}</div><Feedback {...state} />
    {state.data && !state.data.available ? <p className="cc-notice">{state.data.message || 'Non disponible'}</p> : state.data?.available && <>
      <dl className="cc-facts"><div><dt>Système</dt><dd>{typeof system.os === 'string' ? system.os : 'Non disponible'}</dd></div><div><dt>Uptime</dt><dd>{typeof system.uptime_seconds === 'number' ? duration(system.uptime_seconds) : 'Non disponible'}</dd></div><div><dt>Utilisation CPU, mesure sur 1 seconde</dt><dd>{typeof system.cpu_percent === 'number' ? `${system.cpu_percent} %` : 'Non disponible'}</dd></div><div><dt>RAM utilisée / totale</dt><dd>{bytes(memory.used_bytes)} / {bytes(memory.total_bytes)}</dd></div></dl>
      <h4>Stockage visible par le compte</h4>{disks.length ? <div className="table-wrap"><table><thead><tr><th>Montage</th><th>Utilisé</th><th>Total</th><th>Libre</th></tr></thead><tbody>{disks.map((disk, i) => <tr key={i}><td>{String(disk.mount)}</td><td>{bytes(disk.used_bytes)}</td><td>{bytes(disk.total_bytes)}</td><td>{bytes(disk.available_bytes)}</td></tr>)}</tbody></table></div> : <p>Non disponible</p>}
      <h4>Compteurs réseau</h4><p>Totaux lus dans /proc/net/dev ; ils ne représentent pas un débit instantané.</p>{interfaces.length ? <div className="table-wrap"><table><thead><tr><th>Interface</th><th>Reçu</th><th>Envoyé</th></tr></thead><tbody>{interfaces.map((item, i) => <tr key={i}><td>{String(item.name)}</td><td>{bytes(item.received_bytes)}</td><td>{bytes(item.sent_bytes)}</td></tr>)}</tbody></table></div> : <p>Non disponible</p>}
      <p className="cc-source">{typeof system.measured_at === 'number' ? `Lecture SSH du ${new Date(system.measured_at * 1000).toLocaleString()}` : 'Horodatage non disponible'}</p>
    </>}
  </section>;
}
