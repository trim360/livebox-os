import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
} from "react";
import {
  Activity,
  Bell,
  Check,
  ChevronRight,
  CircleHelp,
  EthernetPort,
  FolderOpen,
  Download,
  Grid2X2,
  HardDrive,
  LockKeyhole,
  LogOut,
  Moon,
  MoreHorizontal,
  Network,
  Paintbrush,
  Phone,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Server,
  Workflow,
  Shield,
  SlidersHorizontal,
  Sun,
  Terminal,
  Users,
  Wifi,
  X,
} from "lucide-react";
import {
  api,
  rec,
  text,
  internetConnected,
  wallpaperFile,
  loadServerWallpaper,
  type Session,
  type Snapshot,
  type Profile,
  type LogEntry,
  type AuthState,
} from "./api";
import { ArcherPanel, TopologyPanel, AdvancedNATPanel, MonitorPanel } from "./NetworkPanels";
import AuthGate from "./AuthGate";
import UserMenu from "./UserMenu";
import Rebirth, { useWorkspace } from "./Rebirth";
const ServerCenter = lazy(() => import("./ServerCenter"));
const ServiceMonitor = lazy(() => import("./ServiceMonitor"));
const AccountsPanel = lazy(() => import("./ServerCenter").then(m => ({ default: m.AccountsPanel })));
import DesktopWindow from './DesktopWindow';
import { clampWindow, desktopPreferences, dockApplications, focusWindow, orderApplications, restoredGeometry, type DesktopPreferences, type DesktopWindowState } from './desktop';
import { ApplicationSettings, AuditApplication, DesktopAppearance, DeviceApplication, DiagnosticApplication, LiveboxTools, NotificationApplication, OverviewApplication, RegistryApplication, RouterApplication, SecurityApplication, StatisticsApplication, Tabs } from './DesktopApps';
import { version } from '../package.json';
import { useRemote } from './ControlPanels';
import SharesPanel from "./SharesPanel";
import { BackupPanel, DiagnosticsPanel, StoragePanel } from "./ToolsPanels";
import {
  StatusPanel,
  DevicesPanel,
  SettingsPanel,
  PortsPanel,
  StatisticsPanel,
  CallsPanel,
  JournalPanel,
  ProfilesPanel,
  PersonalizationPanel,
} from "./Panels";

export type AppId =
  | "status"
  | "devices"
  | "settings"
  | "ports"
  | "stats"
  | "phone"
  | "journal"
  | "profiles"
  | "storage"
  | "diagnostics"
  | "backup"
  | "personalization" | "archer" | "topology" | "advanced-nat" | "monitor"
  | "vpn" | "security" | "servers" | "automations" | "notifications" | "wifi" | "livebox-tools" | "app-settings" | "overview" | "docker" | "terminal" | "system" | "processes" | "logs" | "files" | "accounts" | "services";
export const APPS: {
  id: AppId;
  name: string;
  short: string;
  description: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  color: string;
}[] = [
  { id: "topology", name: "Topologie réseau", short: "Topologie", description: "Les liens observés entre vos routeurs", icon: Network, color: "teal" },
  { id: "archer", name: "Routeurs", short: "Routeurs", description: "Connexion et données des routeurs compatibles", icon: Wifi, color: "blue" },
  { id: "advanced-nat", name: "NAT avancé", short: "NAT avancé", description: "Ouvrir un port sur les deux routeurs", icon: EthernetPort, color: "purple" },
  { id: "monitor", name: "Surveillance réseau", short: "Surveillance", description: "Observations et alertes", icon: Activity, color: "green" },
  {
    id: "status",
    name: "État de la Livebox",
    short: "Ma Livebox",
    description: "Votre connexion en un regard",
    icon: Activity,
    color: "orange",
  },
  {
    id: "devices",
    name: "Périphériques réseau",
    short: "Périphériques",
    description: "Les appareils de votre réseau",
    icon: Network,
    color: "blue",
  },
  {
    id: "settings",
    name: "Paramètres Livebox",
    short: "Paramètres",
    description: "Wi-Fi, DHCP et réseau local",
    icon: Settings2,
    color: "slate",
  },
  {
    id: "ports",
    name: "Gestion des ports",
    short: "Ports NAT / PAT",
    description: "Les règles de redirection",
    icon: EthernetPort,
    color: "purple",
  },
  {
    id: "stats",
    name: "Statistiques",
    short: "Statistiques",
    description: "L’activité de votre connexion",
    icon: Activity,
    color: "green",
  },
  {
    id: "phone",
    name: "Téléphone",
    short: "Téléphone",
    description: "Votre journal d’appels",
    icon: Phone,
    color: "pink",
  },
  {
    id: "journal",
    name: "Journal système",
    short: "Journal système",
    description: "Les événements de votre réseau",
    icon: Terminal,
    color: "teal",
  },
  {
    id: "profiles",
    name: "Profils",
    short: "Profils",
    description: "Vos configurations Livebox",
    icon: Users,
    color: "gold",
  },
  {
    id: "personalization",
    name: "Personnalisation",
    short: "Personnalisation",
    description: "Un bureau à votre image",
    icon: Paintbrush,
    color: "violet",
  },
  {
    id: "storage",
    name: "Explorateur de stockage",
    short: "Stockage USB",
    description: "Les supports USB de votre Livebox",
    icon: FolderOpen,
    color: "gold",
  },
  {
    id: "diagnostics",
    name: "Diagnostic réseau",
    short: "Diagnostic",
    description: "Ping, DNS et état de la communication",
    icon: ShieldCheck,
    color: "blue",
  },
  {
    id: "backup",
    name: "Sauvegarde",
    short: "Sauvegarde",
    description: "Exporter et restaurer Livebox OS",
    icon: Download,
    color: "slate",
  },
  { id: 'wifi', name: 'Wi-Fi', short: 'Wi-Fi', description: 'Bandes, SSID, canaux et réseau invité', icon: Wifi, color: 'blue' },
  { id: 'livebox-tools', name: 'Fonctions Livebox', short: 'Fonctions Livebox', description: 'Services accessibles selon votre firmware', icon: Settings2, color: 'orange' },
  { id: 'vpn', name: 'VPN', short: 'VPN', description: 'Observations WireGuard, OpenVPN et Tailscale', icon: ShieldCheck, color: 'teal' },
  { id: 'security', name: 'Sécurité', short: 'Sécurité', description: 'Lire les contrôles de configuration', icon: Shield, color: 'slate' },
  { id: 'servers', name: 'Serveurs', short: 'Serveurs', description: 'Lectures de serveurs Linux autorisés', icon: Server, color: 'gold' },
  { id: 'automations', name: 'Automatisations', short: 'Automatisations', description: 'Règles locales sur les événements observés', icon: Workflow, color: 'violet' },
  { id: 'notifications', name: 'Notifications', short: 'Notifications', description: 'Historique et acquittement des alertes', icon: Bell, color: 'pink' },
  { id: 'app-settings', name: 'Paramètres de l’application', short: 'Paramètres OS', description: 'Préférences et version de Livebox OS', icon: SlidersHorizontal, color: 'slate' },
  { id: 'overview', name: 'Vue réseau', short: 'Vue réseau', description: 'Synthèse facultative dans une fenêtre', icon: Activity, color: 'green' },
  { id: "docker", name: "Docker", short: "Docker", description: "Conteneurs, images, volumes et commandes confirmées", icon: Server, color: "blue" },
  { id: "terminal", name: "Terminal SSH", short: "Terminal SSH", description: "Session interactive sur votre serveur", icon: Terminal, color: "slate" },
  { id: "system", name: "Informations système", short: "Informations système", description: "Noyau, services, températures et swap", icon: HardDrive, color: "teal" },
  { id: "processes", name: "Processus Linux", short: "Processus Linux", description: "Processus et ressources réellement mesurés", icon: Activity, color: "green" },
  { id: "logs", name: "Centre des journaux", short: "Centre des journaux", description: "Journaux Linux et recherche", icon: Terminal, color: "slate" },
  { id: "files", name: "Explorateur Linux", short: "Explorateur Linux", description: "Répertoires explicitement autorisés", icon: FolderOpen, color: "blue" },
  { id: "accounts", name: "Comptes", short: "Comptes", description: "Utilisateurs et permissions", icon: Users, color: "violet" },
  { id: "services", name: "Service Monitor", short: "Services web", description: "Disponibilité HTTP et historique des services privés", icon: Activity, color: "teal" },
];
export type Preferences = {
  theme: "light" | "dark";
  wallpaper: string;
  fit: "cover" | "contain" | "center";
  blur: number;
  desktop?: DesktopPreferences;
};
type WindowState = DesktopWindowState & { id: AppId };
export type ChangeRequest = { kind: string; values: Record<string, unknown> };
type Prepared = {
  token: string;
  warning: string;
  values: Record<string, unknown>;
};
const defaults: Preferences = {
  theme: "light",
  wallpaper: "signature",
  fit: "cover",
  blur: 0,
};
function initialPreferences(): Preferences {
  try {
    const p = JSON.parse(localStorage.getItem("orange-preferences") || "{}");
    return {
      theme: p.theme === "dark" ? "dark" : "light",
      wallpaper: ["signature", "dune", "night", "custom"].includes(p.wallpaper)
        ? p.wallpaper
        : "signature",
      fit: ["cover", "contain", "center"].includes(p.fit) ? p.fit : "cover",
      blur: Math.min(20, Math.max(0, Number(p.blur) || 0)),
      ...(p.desktop ? { desktop: desktopPreferences(p.desktop) } : {}),
    };
  } catch {
    return defaults;
  }
}

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [density, setDensity] = useState<'comfortable' | 'compact'>(() => {
    try { return JSON.parse(localStorage.getItem('livebox-density') || 'null') === 'compact' ? 'compact' : 'comfortable'; }
    catch { return 'comfortable'; }
  });
  const localAlerts = useRemote<{ acknowledged: number }[]>('/control/notifications', 30000, auth?.authenticated === true);
  const [session, setSession] = useState<Session>({ connected: false });
  const [snapshot, setSnapshot] = useState<Snapshot>({});
  const [events, setEvents] = useState<LogEntry[]>([]);
  const [windows, setWindows] = useState<WindowState[]>([]);
  const workspace = useWorkspace(auth?.authenticated === true, windows, items => setWindows(items as WindowState[]), APPS.map(a => a.id));
  const [preferences, setPreferences] =
    useState<Preferences>(initialPreferences);
  const [image, setImage] = useState("");
  const [clock, setClock] = useState(new Date());
  const [login, setLogin] = useState<Profile | null>(null);
  const [launcher, setLauncher] = useState(false);
  const [query, setQuery] = useState("");
  const [notifications, setNotifications] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [revision, setRevision] = useState(0);
  const [stream, setStream] = useState(false);
  const [backend, setBackend] = useState(true);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const savedPreferences = useRef('');
  const dialogReturnFocus = useRef<HTMLElement | null>(null);

  function notify(message: string) {
    setToast(message);
  }
  const theme = workspace.value.theme || preferences.theme;
  const appearance = desktopPreferences(preferences.desktop);
  const desktopApps = orderApplications(APPS, appearance.icon_order);
  const dockApps = dockApplications(desktopApps, appearance.dock_pinned, windows);
  useEffect(() => {
    try { localStorage.setItem('livebox-density', JSON.stringify(density)); }
    catch { notify('La densité ne peut pas être enregistrée dans ce navigateur.'); }
  }, [density]);
  useEffect(() => {
    const resize = () => setWindows(items => items.map(win => clampWindow(win, innerWidth, innerHeight)));
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  function saveLayout(items: WindowState[]) {
    if (!appearance.remember_windows || !items.length) return;
    try {
      const previous = JSON.parse(localStorage.getItem('livebox-window-layout') || '{}');
      const layout = Object.fromEntries(APPS.flatMap(app => {
        const win = items.find(w => w.id === app.id);
        const geometry = win ? { x: win.x, y: win.y, width: win.width, height: win.height } : restoredGeometry(previous?.[app.id]);
        return Object.keys(geometry).length ? [[app.id, geometry]] : [];
      }));
      localStorage.setItem('livebox-window-layout', JSON.stringify(layout));
    } catch { notify('Les positions ne peuvent pas être enregistrées dans ce navigateur.'); }
  }
  useEffect(() => {
    if (!appearance.remember_windows || !windows.length) return;
    const timer = setTimeout(() => saveLayout(windows), 250);
    const flush = () => saveLayout(windows);
    window.addEventListener('pagehide', flush);
    return () => { clearTimeout(timer); window.removeEventListener('pagehide', flush); };
  }, [windows, appearance.remember_windows]);
  const checkAuth = () =>
    api<AuthState>("/auth/state")
      .then(setAuth)
      .catch(() => {
        setAuth(null);
        setBackend(false);
      });
  useEffect(() => {
    checkAuth();
  }, []);
  useEffect(() => {
    if (auth?.authenticated)
      api<Session>("/session")
        .then(setSession)
        .catch(() => setBackend(false));
  }, [auth?.authenticated]);
  useEffect(() => {
    if (!auth?.authenticated) {
      setPreferencesLoaded(false);
      return;
    }
    let alive = true;
    api<Partial<Preferences>>("/preferences")
      .then(async (saved) => {
        if (!alive) return;
        if (saved.theme) {
          savedPreferences.current = JSON.stringify(saved);
          setPreferences(saved as Preferences);
        }
        const blob = await loadServerWallpaper();
        if (blob && alive) {
          await wallpaperFile(blob);
          setImage(URL.createObjectURL(blob));
        } else if (alive) {
          const localImage = await wallpaperFile();
          if (localImage) await api('/wallpaper', localImage, 'PUT');
        }
        if (alive) setPreferencesLoaded(true);
      })
      .catch((e) => {
        if (alive) {
          notify(e.message);
          setPreferencesLoaded(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [auth?.authenticated]);
  useEffect(() => {
    if (!auth?.authenticated || !preferencesLoaded) return;
    const serialized = JSON.stringify(preferences);
    if (serialized === savedPreferences.current) return;
    const timer = setTimeout(
      () =>
        api("/preferences", preferences, "PUT")
          .then(() => { savedPreferences.current = serialized; })
          .catch((e) => notify(e.message)),
      600,
    );
    return () => clearTimeout(timer);
  }, [preferences, preferencesLoaded, auth?.authenticated]);
  useEffect(() => {
    const expired = (event: Event) => {
      const code = (event as CustomEvent).detail;
      setSession({ connected: false });
      setSnapshot({});
      setEvents([]);
      if (code === "APP_AUTH_REQUIRED") {
        setAuth((s) => (s ? { ...s, authenticated: false } : null));
        setWindows([]);
      } else notify("La session Livebox a expiré. Reconnectez votre Livebox.");
    };
    window.addEventListener("orange-session-expired", expired);
    return () => window.removeEventListener("orange-session-expired", expired);
  }, []);
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    try {
      localStorage.setItem("orange-preferences", JSON.stringify(preferences));
    } catch {
      notify(
        "Les préférences ne peuvent pas être enregistrées dans ce navigateur.",
      );
    }
  }, [preferences]);
  useEffect(() => {
    wallpaperFile()
      .then((blob) => {
        if (blob) setImage(URL.createObjectURL(blob));
      })
      .catch(() => {});
  }, []);
  useEffect(
    () => () => {
      if (image) URL.revokeObjectURL(image);
    },
    [image],
  );
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLogin(null);
        setMenu(null);
        setLauncher(false);
        setNotifications(false);
        if (!confirming) setPrepared(null);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [confirming]);
  useEffect(() => {
    if (!login && !prepared) return;
    const dialog = document.querySelector<HTMLElement>('.login-modal, .confirmation-modal');
    const selector = 'input:not([disabled]), select:not([disabled]), button:not([disabled]), a[href]';
    dialog?.querySelector<HTMLElement>(selector)?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !dialog) return;
      const fields = [...dialog.querySelectorAll<HTMLElement>(selector)];
      const first = fields[0], last = fields[fields.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', trap);
    return () => {
      document.removeEventListener('keydown', trap);
      if (dialogReturnFocus.current?.isConnected) dialogReturnFocus.current.focus({ preventScroll: true });
    };
  }, [login, prepared]);
  useEffect(() => {
    if (!session.connected) {
      setSnapshot({});
      setStream(false);
      return;
    }
    let stopped = false;
    let socket: WebSocket;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`,
      );
      socket.onopen = () => {
        if (!stopped) setStream(true);
      };
      socket.onmessage = (e) => {
        try {
          const data: Snapshot = JSON.parse(e.data);
          if (data.updated) setSnapshot(data);
          if (data.events) setEvents(data.events);
        } catch {
          /* Ignore malformed frames. */
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        setStream(false);
        api<AuthState>("/auth/state")
          .then((state) => {
            if (!stopped) setAuth(state);
            return api<Session>("/session");
          })
          .then((s) => {
            if (!stopped) {
              setSession(s);
              if (s.connected) retry = setTimeout(connect, 5000);
            }
          })
          .catch(() => {
            if (!stopped) retry = setTimeout(connect, 5000);
          });
      };
    };
    api<Snapshot>("/status")
      .then((d) => {
        if (!stopped) setSnapshot(d);
      })
      .catch((e) => notify(e.message));
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [session.connected, session.url, revision]);

  const openApp = (id: AppId) => {
    setLauncher(false);
    setMenu(null);
    let saved = {};
    if (appearance.remember_windows) {
      try { saved = restoredGeometry(JSON.parse(localStorage.getItem('livebox-window-layout') || '{}')?.[id]); }
      catch { saved = {}; }
    }
    setWindows(current => focusWindow(current.some(w => w.id === id)
      ? current.map(w => w.id === id ? { ...w, minimized: false } : w)
      : [...current, clampWindow({ id, x: Math.max(10, Math.min(innerWidth - 780, 180 + current.length * 25)), y: 90 + (current.length % 5) * 24,
        width: 780, height: 570, z: 10, ...saved, minimized: false, maximized: false }, innerWidth, innerHeight)], id));
  };
  const focus = (id: AppId) =>
    setWindows(current => current.every(w => w.id === id || w.minimized || w.z < (current.find(w => w.id === id)?.z || 0)) ? current : focusWindow(current, id));
  const patchWindow = (id: AppId, patch: Partial<Omit<WindowState, 'id'>>) =>
    setWindows((current) =>
      current.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    );
  const closeWindow = (id: AppId) => {
    saveLayout(windows);
    setWindows(items => items.filter(win => win.id !== id));
  };
  const showLogin = (profile?: Profile) => {
    dialogReturnFocus.current = document.activeElement as HTMLElement;
    setLogin(
      profile || {
        name: "Ma Livebox",
        url: "http://192.168.1.1",
        username: "admin",
      },
    );
  };
  const disconnected = (
    <div className="empty-state">
      <span className="empty-icon">
        <LockKeyhole size={28} />
      </span>
      <h3>Votre Livebox vous attend</h3>
      <p>
        Connectez-vous pour accéder aux informations réelles de votre réseau.
      </p>
      <button className="primary" onClick={() => showLogin()}>
        Connecter ma Livebox <ChevronRight size={16} />
      </button>
    </div>
  );
  async function requestChange(change: ChangeRequest) {
    dialogReturnFocus.current = document.activeElement as HTMLElement;
    try {
      setPrepared(await api<Prepared>("/changes/prepare", change));
    } catch (e) {
      notify((e as Error).message);
    }
  }
  async function confirmChange() {
    if (!prepared || confirming) return;
    setConfirming(true);
    try {
      const result = await api<{ message: string }>("/changes/confirm", {
        token: prepared.token,
      });
      notify(result.message);
      setRevision((r) => r + 1);
    } catch (e) {
      notify((e as Error).message);
    } finally {
      setPrepared(null);
      setConfirming(false);
    }
  }
  async function logout() {
    try {
      await api("/logout", {});
      await api("/auth/logout", {});
      setAuth((s) => (s ? { ...s, authenticated: false } : null));
      setSession({ connected: false });
      setEvents([]);
      setWindows([]);
      notify("Session fermée.");
    } catch (e) {
      notify((e as Error).message);
    }
  }
  const connected = session.connected && internetConnected(snapshot);
  const info = rec(snapshot.info?.data);
  const panel = (id: AppId) => {
    if (["docker", "terminal", "system", "processes", "logs", "files"].includes(id)) return <Suspense fallback={<p className="panel">Chargement…</p>}><ServerCenter mode={id} openServers={() => openApp("servers")} /></Suspense>;
    if (id === "services") return <Suspense fallback={<p className="panel">Chargement…</p>}><ServiceMonitor /></Suspense>;
    if (id === "accounts") return <Suspense fallback={<p className="panel">Chargement…</p>}><AccountsPanel /></Suspense>;
    if (id === "personalization")
      return (
        <><PersonalizationPanel
          preferences={preferences}
          update={setPreferences}
          image={image}
          onImage={setImage}
          notify={notify}
        /><DesktopAppearance preferences={preferences} update={setPreferences} apps={APPS} /></>
      );
    if (id === "profiles")
      return <ProfilesPanel connect={showLogin} notify={notify} revision={revision} />;
    if (id === "diagnostics") return <DiagnosticApplication legacy={<DiagnosticsPanel />} />;
    if (id === "backup")
      return (
        <BackupPanel
          restored={() => setRevision(value => value + 1)}
          preferences={preferences}
          update={setPreferences}
          onImage={setImage}
          notify={notify}
        />
      );
    if (id === "archer") return <RouterApplication legacy={<ArcherPanel />} />;
    if (id === 'vpn' || id === 'servers' || id === 'automations') return <RegistryApplication kind={id} open={openApp} />;
    if (id === 'notifications') return <NotificationApplication open={openApp} />;
    if (id === 'security') return <SecurityApplication session={session} open={openApp} />;
    if (id === 'livebox-tools') return <LiveboxTools connected={session.connected} connect={() => showLogin()} open={openApp} />;
    if (id === 'app-settings') return <ApplicationSettings density={density} setDensity={setDensity} preferences={preferences} update={setPreferences} open={openApp} />;
    if (id === 'devices') return <DeviceApplication legacy={session.connected ? <DevicesPanel revision={revision} /> : disconnected} />;
    if (id === 'stats') return <StatisticsApplication legacy={session.connected ? <StatisticsPanel snapshot={snapshot} /> : disconnected} />;
    if (id === 'journal') return <AuditApplication legacy={session.connected ? <JournalPanel entries={events} revision={revision} /> : disconnected} />;
    if (id === 'overview') return <OverviewApplication session={session} snapshot={snapshot} connect={() => showLogin()} open={openApp} statistics={session.connected ? <StatisticsPanel snapshot={snapshot} /> : disconnected} />;
    if (id === 'wifi') return <div className="v4-application"><Tabs tabs={[{ name: 'Wi-Fi principal', content: session.connected ? <SettingsPanel revision={revision} change={requestChange} /> : disconnected }, { name: 'Invité et planification', content: <LiveboxTools connected={session.connected} connect={() => showLogin()} open={openApp} /> }]} /></div>;
    if (id === "topology") return <TopologyPanel />;
    if (id === "advanced-nat") return <AdvancedNATPanel />;
    if (id === "monitor") return <MonitorPanel />;
    if (id === "storage") return <><SharesPanel />{session.connected ? <StoragePanel revision={revision} /> : <div className="panel"><p>Connectez la Livebox pour consulter ses supports USB.</p></div>}</>;
    if (!session.connected) return disconnected;
    switch (id) {
      case "status":
        return (
          <StatusPanel snapshot={snapshot} session={session} open={openApp} />
        );
      case "settings":
        return <SettingsPanel revision={revision} change={requestChange} />;
      case "ports":
        return <PortsPanel revision={revision} change={requestChange} />;
      case "phone":
        return <CallsPanel revision={revision} />;
    }
  };

  return (
    <main
      className={`os desktop-os rebirth-os motion-${workspace.value.motion} accent-${workspace.value.accent} ${theme} density-${density} icons-${appearance.icon_size} ${appearance.animations ? '' : 'motion-disabled'}`}
      data-accent={appearance.accent}
      onClick={() => menu && setMenu(null)}
    >
      <a className="desktop-skip" href="#desktop-applications">Aller aux applications</a>
      <div
        className={`wallpaper wallpaper-${preferences.wallpaper === "custom" && !image ? "signature" : preferences.wallpaper}`}
        style={{
          filter: `blur(${preferences.blur}px)`,
          ...(preferences.wallpaper === "custom" && image
            ? {
                backgroundImage: `url(${image})`,
                backgroundPosition: `${appearance.wallpaper_x}% ${appearance.wallpaper_y}%`,
                backgroundSize:
                  preferences.fit === "center" ? "auto" : preferences.fit,
              }
            : {}),
        }}
      >
        <div className="orb orb-one" />
        <div className="orb orb-two" />
        <div className="wallpaper-lines" />
      </div>
      <div
        className="desktop-surface"
        onContextMenu={(e) => {
          if (
            !(e.target as HTMLElement).closest(
              ".os-window, button, .login-modal",
            )
          ) {
            e.preventDefault();
            setMenu({
              x: Math.min(e.clientX, innerWidth - 245),
              y: Math.min(e.clientY, innerHeight - 210),
            });
          }
        }}
      >
        <header className="desktop-header">
          <div className="brand">
            <img
              className="brand-logo"
              src="/livebox-logo.svg"
              alt="Logo Livebox OS"
            />
            <span className="brand-name">
              Livebox <b>OS</b>
              <small>REBIRTH · VOTRE ESPACE RÉSEAU.</small>
            </span>
            <span className="version" title={version}>{version}</span>
          </div>
          <div className="header-right">
            <span className="local-badge">
              <ShieldCheck size={14} /> Espace local sécurisé
            </span>
            <button
              className="round-button"
              title="Changer de thème"
              aria-label="Changer de thème"
              onClick={() => workspace.setValue(v => ({ ...v, theme: theme === "dark" ? "light" : "dark" }))}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </button>
            <span className="header-divider" />
            <UserMenu active={auth?.authenticated === true} profiles={() => openApp("profiles")} logout={() => void logout()} />
          </div>
        </header>
        <Rebirth active={auth?.authenticated === true} apps={desktopApps} open={id => openApp(id as AppId)}
          session={session} snapshot={snapshot} events={events} workspace={{ ...workspace.value, windows }} update={workspace.setValue}
          error={workspace.error} connect={() => showLogin()} arrange={() => setWindows(items => items.map((w, i) => clampWindow({ ...w, maximized: false, minimized: false, x: 100 + i * 32, y: 90 + i * 26, width: 780, height: 570 }, innerWidth, innerHeight)))} />
      </div>
      {windows.map((win) => {
        const app = APPS.find((a) => a.id === win.id)!;
        return (
          <DesktopWindow key={win.id} win={win} name={app.name} color={app.color} icon={app.icon}
            focus={() => focus(win.id)} patch={patch => patchWindow(win.id, patch)} close={() => closeWindow(win.id)}
            status={win.id === 'personalization' ? 'Préférences du bureau' : session.connected ? `${session.name} · ${session.url}` : 'Données selon les équipements connectés'}>
            {panel(win.id)}
          </DesktopWindow>
        );
      })}
      <nav className="taskbar" aria-label="Barre des tâches">
        <button
          className={`launcher-button ${launcher ? "selected" : ""}`}
          aria-label="Toutes les applications"
          onClick={() => {
            setLauncher(!launcher);
            setNotifications(false);
          }}
        >
          <Grid2X2 size={23} />
        </button>
        <span className="task-divider" />
        <div className="task-apps">
          {dockApps.map((app) => (
            <button
              className={`task-app ${windows.some((w) => w.id === app.id && !w.minimized) ? "active" : ""}`}
              key={app.id}
              aria-label={app.name}
              title={app.name}
              onClick={() => {
                const win = windows.find((w) => w.id === app.id);
                if (
                  win &&
                  !win.minimized &&
                  win.z ===
                    Math.max(
                      ...windows.filter((w) => !w.minimized).map((w) => w.z),
                    )
                )
                  patchWindow(app.id, { minimized: true });
                else openApp(app.id);
              }}
            >
              <span className={`task-app-icon ${app.color}`}>
                <app.icon size={20} strokeWidth={1.8} />
              </span>
              {windows.some((w) => w.id === app.id) && <i />}
            </button>
          ))}
        </div>
        <div className="taskbar-right">
          <span className="task-divider" />
          <button
            className={`tray-connect ${connected ? "is-online" : ""}`}
            aria-label="Connexion Livebox"
            title={
              connected ? "Connexion Internet active" : "Connexion Livebox"
            }
            onClick={() =>
              session.connected ? openApp("status") : showLogin()
            }
          >
            <Wifi size={19} />
          </button>
          <button
            className="notification-button"
            aria-label="Notifications"
            onClick={() => {
              setNotifications(!notifications);
              setLauncher(false);
            }}
          >
            <Bell size={18} />
            {(events.length > 0 || localAlerts.data?.some(item => !item.acknowledged)) && <i />}
          </button>
          <button
            className="task-clock"
            onClick={() => setNotifications(!notifications)}
          >
            <strong>
              {clock.toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </strong>
            <span>
              {clock.toLocaleDateString("fr-FR", {
                day: "2-digit",
                month: "2-digit",
                year: "numeric",
              })}
            </span>
          </button>
          <button
            className="show-desktop"
            aria-label="Afficher le bureau"
            onClick={() =>
              setWindows((w) => w.map((a) => ({ ...a, minimized: true })))
            }
          />
        </div>
      </nav>
      {launcher && (
        <>
          <div className="dismiss-layer" onClick={() => setLauncher(false)} />
          <section className="launcher popup">
            <div className="launcher-header">
              <h2>Vos applications</h2>
              <span>Livebox OS</span>
            </div>
            <label className="search-field">
              <Search size={16} />
              <input
                autoFocus
                placeholder="Rechercher une application…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="launcher-grid">
              {desktopApps.filter((a) =>
                a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              ).map((app) => (
                <button key={app.id} onClick={() => openApp(app.id)}>
                  <span className={`task-app-icon ${app.color}`}>
                    <app.icon size={23} />
                  </span>
                  <span>
                    {app.name}
                    <small>{app.description}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
            {!APPS.some((a) =>
              a.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
            ) && <p className="muted">Aucune application trouvée.</p>}
            <div className="launcher-bottom">
              <span>
                <ShieldCheck size={14} /> Administration locale
              </span>
              <button onClick={logout}>
                <LogOut size={15} /> Verrouiller Livebox OS
              </button>
            </div>
          </section>
        </>
      )}
      {notifications && (
        <>
          <div
            className="dismiss-layer"
            onClick={() => setNotifications(false)}
          />
          <section className="notifications popup">
            <div className="launcher-header">
              <h2>Notifications</h2>
              <button
                className="icon-button"
                aria-label="Fermer les notifications"
                onClick={() => setNotifications(false)}
              >
                <X size={18} />
              </button>
            </div>
            <div className="notification-date">
              {clock.toLocaleDateString("fr-FR", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </div>
            <button className="secondary notification-center-link" onClick={() => { setNotifications(false); openApp('notifications'); }}>Ouvrir le centre de notifications{localAlerts.data?.some(item => !item.acknowledged) ? ' · alertes à consulter' : ''}</button>
            {events.length ? (
              events.slice(0, 10).map((entry, i) => (
                <div key={i} className="notification-item">
                  <span className="notification-icon">
                    <Activity size={16} />
                  </span>
                  <div>
                    <strong>{entry.message}</strong>
                    <small>
                      {new Date(entry.time * 1000).toLocaleTimeString("fr-FR")}{" "}
                      · {entry.source}
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state compact">
                <Bell size={29} />
                <h3>Tout est tranquille.</h3>
                <p>
                  Les événements observés apparaîtront ici après connexion à
                  votre Livebox.
                </p>
              </div>
            )}
          </section>
        </>
      )}
      {menu && (
        <div
          className="context-menu popup"
          style={{ left: menu.x, top: menu.y }}
        >
          <button onClick={() => openApp("personalization")}>
            <Paintbrush size={15} /> Changer le fond d’écran
          </button>
          <button
            onClick={() => {
              setPreferences((p) => ({
                ...p,
                theme: p.theme === "dark" ? "light" : "dark",
              }));
              setMenu(null);
            }}
          >
            <Moon size={15} /> Changer de thème
          </button>
          <hr />
          <button
            onClick={() => {
              setWindows((w) => w.map((a) => ({ ...a, minimized: true })));
              setMenu(null);
            }}
          >
            <Grid2X2 size={15} /> Afficher le bureau
          </button>
          <button
            onClick={() => {
              setRevision((r) => r + 1);
              setMenu(null);
              notify("Bureau actualisé.");
            }}
          >
            <RefreshCw size={15} /> Actualiser
          </button>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          <span className="notification-icon">
            <CircleHelp size={17} />
          </span>
          <span>{toast}</span>
          <button
            className="icon-button"
            aria-label="Fermer le message"
            onClick={() => setToast("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {login && (
        <LoginModal
          profile={login}
          close={() => setLogin(null)}
          connected={(s) => {
            setSession(s);
            setBackend(true);
            setLogin(null);
            setRevision((r) => r + 1);
            notify("Votre Livebox est connectée. Bienvenue chez vous.");
            openApp("status");
          }}
        />
      )}
      {prepared && (
        <div className="modal-backdrop">
          <section
            className="confirmation-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirmation-title"
          >
            <span className="modal-symbol">
              <ShieldCheck size={27} />
            </span>
            <h2 id="confirmation-title">Confirmer la modification</h2>
            <p>{prepared.warning}</p>
            <details open>
              <summary>Paramètres envoyés à la Livebox</summary>
              <pre>{JSON.stringify(prepared.values, null, 2)}</pre>
            </details>
            <div className="button-row">
              <button
                disabled={confirming}
                className="secondary"
                onClick={() => setPrepared(null)}
              >
                Annuler
              </button>
              <button
                disabled={confirming}
                className="primary"
                onClick={confirmChange}
              >
                {confirming ? "Application…" : "Confirmer et appliquer"}
                <Check size={16} />
              </button>
            </div>
          </section>
        </div>
      )}
      {!auth?.authenticated && (
        <AuthGate
          state={auth}
          retry={checkAuth}
          complete={(state) => {
            setAuth(state);
            setBackend(true);
          }}
        />
      )}
    </main>
  );
}

function LoginModal({
  profile,
  close,
  connected,
}: {
  profile: Profile;
  close: () => void;
  connected: (session: Session) => void;
}) {
  const [form, setForm] = useState(profile);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop">
      <section
        className="login-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="login-title"
      >
        <button
          className="modal-close icon-button"
          onClick={close}
          disabled={busy}
          aria-label="Fermer la connexion"
        >
          <X size={19} />
        </button>
        <span className="modal-symbol">
          <HardDrive size={28} />
        </span>
        <span className="eyebrow">BIENVENUE CHEZ VOUS</span>
        <h2 id="login-title">Connecter ma Livebox</h2>
        <p>
          Utilisez les identifiants de l’interface d’administration de votre
          Livebox.
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            try {
              connected(await api<Session>("/login", { ...form, password }));
              setPassword("");
            } catch (error) {
              setError((error as Error).message);
              setPassword("");
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Nom du profil
            <input
              value={form.name}
              maxLength={60}
              required
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label>
            Adresse de la Livebox
            <input
              value={form.url}
              required
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="http://192.168.1.1"
            />
          </label>
          <div className="form-grid">
            <label>
              Identifiant
              <input
                autoComplete="username"
                value={form.username}
                required
                onChange={(e) => setForm({ ...form, username: e.target.value })}
              />
            </label>
            <label>
              Mot de passe
              <input
                autoFocus
                type="password"
                autoComplete="current-password"
                value={password}
                required
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </div>
          {error && (
            <div role="alert" className="error-message">
              {error}
            </div>
          )}
          <button className="primary wide" disabled={busy}>
            {busy ? "Connexion en cours…" : "Se connecter"}
            <ChevronRight size={17} />
          </button>
        </form>
        <div className="login-security">
          <LockKeyhole size={15} />
          <span>
            Le mot de passe n’est jamais enregistré. La session Livebox reste en
            mémoire côté serveur.
          </span>
        </div>
      </section>
    </div>
  );
}
