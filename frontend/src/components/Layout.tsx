import {Link,Outlet,useLocation,useNavigate} from 'react-router-dom';
import {useState} from 'react';
import {hasPermission,logout,storedUser} from '../lib/api';
import '../polish.css';

type Item=[string,string,string,string?];

type PageMeta={title:string;description:string;group:string};

const pageMeta:Record<string,PageMeta>={
  '/':{title:'Übersicht',description:'Zentrale Übersicht über die aktuelle Sicherheitslage, offene Vorgänge und operative Kennzahlen.',group:'Leitstelle'},
  '/map':{title:'Live-Karte',description:'Aktuelle Positionen und Standorte der eingesetzten Geräte im Überblick.',group:'Leitstelle'},
  '/alarms':{title:'Alarme',description:'Alarme prüfen, priorisieren, übernehmen und revisionssicher bearbeiten.',group:'Leitstelle'},
  '/incidents':{title:'Einsätze',description:'Einsätze und Ereignisse dokumentieren, verfolgen und abschließen.',group:'Leitstelle'},
  '/operative-leitstelle':{title:'Operative Leitstelle',description:'Tageslage, Handlungsbedarf, Besetzung, Nachweise und Maßnahmen der operativen Leitstelle.',group:'Leitstelle'},
  '/einsatz':{title:'Einsatzmanagement',description:'Vorfälle, Alarme, Maßnahmen, Eskalationen und Auswertungen revisionssicher bearbeiten.',group:'Leitstelle'},
  '/patrols':{title:'Kontrollgänge',description:'Kontrollgänge, Kontrollpunkte und Abweichungen im Überblick.',group:'Leitstelle'},
  '/mobile':{title:'Mobile Einsatz-App',description:'Mobile Leitstellenfunktionen für den Einsatz vor Ort.',group:'Betrieb'},
  '/watchbook':{title:'Wachbuch',description:'Wachbucheinträge nachvollziehbar erfassen, korrigieren und schließen.',group:'Betrieb'},
  '/scheduling':{title:'Dienstplanung',description:'Dienstpläne, Schichten und Besetzungen für den operativen Alltag verwalten.',group:'Betrieb'},
  '/handovers':{title:'Schichtübergaben',description:'Schichtübergaben strukturiert dokumentieren und bestätigen.',group:'Betrieb'},
  '/messages':{title:'Nachrichten',description:'Interne Nachrichten und wichtige Informationen sicher austauschen.',group:'Betrieb'},
  '/employees':{title:'Mitarbeiter',description:'Mitarbeiter, Kontaktdaten und operative Zuordnungen verwalten.',group:'Verwaltung'},
  '/customers':{title:'Kunden',description:'Kundenstammdaten und Ansprechpartner zentral pflegen.',group:'Verwaltung'},
  '/sites':{title:'Objekte',description:'Objekte, Adressen und sicherheitsrelevante Standortdaten verwalten.',group:'Verwaltung'},
  '/devices':{title:'Geräte',description:'Betriebsgeräte, ihre Zuordnungen und ihren Status verwalten.',group:'Verwaltung'},
  '/keys':{title:'Schlüssel',description:'Schlüssel, Schlüsselbünde, Ausgaben, Verlustmeldungen und Bestandskontrollen verwalten.',group:'Verwaltung'},
  '/nfc-devices':{title:'NFC-Geräte',description:'NFC-Geräte registrieren, zuordnen und bei Bedarf sperren.',group:'Verwaltung'},
  '/qualifications':{title:'Qualifikationen',description:'Qualifikationen und Gültigkeiten von Mitarbeitern verwalten.',group:'Verwaltung'},
  '/dms':{title:'Dokumente',description:'Sicherheitsrelevante Dokumente in Fassungen und revisionssicher verwalten.',group:'Dokumente & Auswertungen'},
  '/reports':{title:'Auswertungen',description:'Kennzahlen, Arbeitszeiten und exportierbare Berichte für Auswertung und Nachweis.',group:'Dokumente & Auswertungen'},
  '/customer-reports':{title:'Kundenberichte',description:'Berichte für Kunden erstellen und kontrolliert bereitstellen.',group:'Dokumente & Auswertungen'},
  '/notifications':{title:'Benachrichtigungen',description:'Benachrichtigungen und persönliche Zustellungen im Blick behalten.',group:'System'},
  '/telemetry':{title:'Sensoren',description:'Sensorwerte und Schwellenwerte zur technischen Überwachung auswerten.',group:'System'},
  '/alarm-forwarding':{title:'Alarmweiterleitung',description:'Alarmweiterleitungen und Eskalationsregeln für externe Ziele konfigurieren.',group:'System'},
  '/account-security':{title:'Kontosicherheit',description:'Zwei-Faktor-Authentifizierung, Sitzungen und Sicherheitsoptionen des eigenen Kontos verwalten.',group:'System'},
  '/admin':{title:'Administration',description:'Systemweite Einstellungen, Backups, Integrationen und Audit-Nachweise verwalten.',group:'System'},
};

const permissionAliases:Record<string,string[]>={
  '/customer-reports':['customer_reports:export','customer_portal:read'],
  '/operative-leitstelle':['nsl:read','operations_measures:read'],
  '/einsatz':['incidents:read','alarms:read','operations_measures:read'],
};

const groups:{label:string;items:Item[]}[]=[
  {label:'Leitstelle',items:[['/','Übersicht','nsl:read'],['/operative-leitstelle','Operative Leitstelle','nsl:read','⌖'],['/einsatz','Einsatzmanagement','incidents:read','◈'],['/map','Live-Karte','positions:read'],['/alarms','Alarme','alarms:read'],['/incidents','Einsätze','incidents:read'],['/patrols','Kontrollgänge','patrols:read']]},
  {label:'Betrieb',items:[['/mobile','Mobile Einsatz-App','alarms:write'],['/watchbook','Wachbuch','watchbook:read'],['/scheduling','Dienstplanung','scheduling:read'],['/handovers','Schichtübergaben','handover:read'],['/messages','Nachrichten','messages:read']]},
  {label:'Verwaltung',items:[['/employees','Mitarbeiter','employees:read'],['/customers','Kunden','customers:read'],['/sites','Objekte','sites:read'],['/devices','Geräte','devices:read'],['/keys','Schlüssel','keys:read'],['/nfc-devices','NFC-Geräte','nfc_devices:read'],['/qualifications','Qualifikationen','employees:read']]},
  {label:'Dokumente & Auswertungen',items:[['/dms','Dokumente','dms:read'],['/reports','Auswertungen','reports:read'],['/customer-reports','Kundenberichte','customer_reports:export']]},
  {label:'System',items:[['/notifications','Benachrichtigungen','notifications:read'],['/telemetry','Sensoren','telemetry:read'],['/alarm-forwarding','Alarmweiterleitung','alarm_forwarding:read'],['/account-security','Kontosicherheit','account_security:read'],['/admin','Administration','audit:read']]},
];

function basePath(pathname:string):string{
  const match=/^\/[^/]+/.exec(pathname);
  return match?match[0]:'/';
}

export function Layout(){
  const nav=useNavigate();
  const location=useLocation();
  const [open,setOpen]=useState(false);
  const user=storedUser();
  const visible=groups.map(group=>({
    ...group,
    items:group.items.filter(([path, ,permission])=>(permissionAliases[path]??[permission]).some(hasPermission)),
  })).filter(group=>group.items.length);
  const currentPath=basePath(location.pathname);
  const meta=pageMeta[currentPath]??pageMeta['/'];
  const title=meta.title;
  const description=meta.description;
  const breadcrumb=`SECURITYOPS / ${meta.group.toUpperCase()} / ${title.toUpperCase()}`;
  const isDetailPath=location.pathname!==currentPath;
  const darkPage=isDetailPath||['/employees','/customers','/keys','/sites','/nfc-devices'].includes(currentPath);

  return <div className="app-shell theme-dark">
    <aside className={open?'sidebar open':'sidebar'}>
      <div className="brand"><span className="brand-mark">S</span><span>Security<strong>Ops</strong></span></div>
      <div className="workspace"><span className="status-dot"/> Leitstelle <small>PRODUKTIVBETRIEB</small></div>
      <nav className="side-nav" aria-label="Hauptnavigation">
        {visible.map(group=><div className="nav-group" key={group.label}>
          <div className="nav-label">{group.label}</div>
          {group.items.map(([path,label,_permission,icon])=><Link className={location.pathname===path||(isDetailPath&&path===currentPath)?'nav-item active':'nav-item'} key={path} to={path} onClick={()=>setOpen(false)}>
            <span className="nav-icon" aria-hidden="true">{icon??label.charAt(0)}</span>{label}
          </Link>)}
        </div>)}
      </nav>
      <button className="logout" onClick={async()=>{
        try{await logout();}catch{}
        localStorage.removeItem('securityops_authenticated');
        localStorage.removeItem('securityops_user');
        nav('/login');
      }}>Abmelden</button>
    </aside>
    <div className="app-content">
      <header className={darkPage?'topbar topbar-dark':'topbar'}>
        <button className="menu-toggle" onClick={()=>setOpen(!open)} aria-label="Navigation öffnen">☰</button>
        <div>
          <div className="breadcrumb">{breadcrumb}</div>
          <h1>{title}</h1>
          {description&&<p className="page-description">{description}</p>}
        </div>
        <div className="user-menu"><span className="status-dot"/> <span>{user?.email||'Benutzerkonto'}</span></div>
      </header>
      <main className={darkPage?'page-content employee-page':'page-content'}><Outlet/></main>
    </div>
  </div>;
}
