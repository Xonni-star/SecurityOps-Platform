import {Link,useNavigate} from 'react-router-dom';
import {ReactNode} from 'react';
import {hasPermission,logout} from '../lib/api';

export function Layout({children}:{children:ReactNode}){
  const nav=useNavigate();
  const links:[string,string,string][]=[['/','NSL','nsl:read'],['/mobile','Wächter-App','alarms:write'],['/watchbook','Wachbuch','watchbook:read'],['/scheduling','Dienstplanung','scheduling:read'],['/dms','Dokumente','dms:read'],['/keys','Schlüssel','keys:read'],['/handovers','Schichtübergaben','handover:read'],['/reports','Reports','reports:read'],['/admin','Admin','audit:read'],['/nfc-devices','NFC','nfc_devices:read'],['/map','Live-Karte','positions:read'],['/telemetry','Sensorik','telemetry:read'],['/incidents','Einsätze','incidents:read'],['/messages','Nachrichten','messages:read'],['/notifications','Benachrichtigungen','notifications:read'],['/employees','Mitarbeiter','employees:read'],['/customers','Kunden','customers:read'],['/sites','Objekte','sites:read'],['/devices','Geräte','devices:read'],['/patrols','Kontrollgänge','patrols:read']];
  return <div><header><strong>SecurityOps</strong><nav>{links.filter(([, ,permission])=>hasPermission(permission)).map(([path,label])=><Link key={path} to={path}>{label}</Link>)} <button onClick={async()=>{await logout();localStorage.removeItem('securityops_authenticated');localStorage.removeItem('securityops_user');nav('/login')}}>Abmelden</button></nav></header><main>{children}</main></div>;
}
