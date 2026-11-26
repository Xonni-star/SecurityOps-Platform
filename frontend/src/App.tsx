import {useEffect,useState} from 'react';
import {BrowserRouter,Link,Navigate,Route,Routes} from 'react-router-dom';
import {api,type ClientUser} from './lib/api';
import {Layout} from './components/Layout';
import {Login} from './pages/Login';
import {Operations} from './pages/Operations';
import {Patrols} from './pages/Patrols';
import {LiveMap} from './pages/LiveMap';
import {Telemetry} from './pages/Telemetry';
import {Incidents} from './pages/Incidents';
import {NslDashboard} from './pages/NslDashboard';
import {Messages} from './pages/Messages';
import {Notifications} from './pages/Notifications';
import {Reports} from './pages/Reports';
import {Admin} from './pages/Admin';
import {NfcDevices} from './pages/NfcDevices';
import {MobileGuard} from './pages/MobileGuard';
import {Watchbook} from './pages/Watchbook';
import {Scheduling} from './pages/Scheduling';
import {Dms} from './pages/Dms';
import {Keys} from './pages/Keys';
import {KeyDetail} from './pages/KeyDetail';
import {Handovers} from './pages/Handovers';
import {Qualifications} from './pages/Qualifications';
import {AlarmForwarding} from './pages/AlarmForwarding';
import {CustomerReports} from './pages/CustomerReports';
import {AccountSecurity} from './pages/AccountSecurity';
import {Sites} from './pages/Sites';
import {Devices,DeviceFile} from './pages/Devices';
import {Employees} from './pages/Employees';
import {EmployeeDetail} from './pages/EmployeeDetail';
import {Customers} from './pages/Customers';
import {CustomerDetail} from './pages/CustomerDetail';

function clearSession(){
  localStorage.removeItem('securityops_authenticated');
  localStorage.removeItem('securityops_user');
}

function ProtectedLayout(){
  const [state,setState]=useState<'checking'|'authenticated'|'anonymous'>('checking');
  useEffect(()=>{
    let active=true;
    if(!localStorage.getItem('securityops_authenticated')){setState('anonymous');return;}
    api<{user:ClientUser}>('/auth/me').then(result=>{
      if(!active)return;
      if(!result?.user)throw new Error('Die Sitzung konnte nicht geprüft werden.');
      localStorage.setItem('securityops_user',JSON.stringify(result.user));
      setState('authenticated');
    }).catch(()=>{
      if(!active)return;
      clearSession();
      setState('anonymous');
    });
    return ()=>{active=false;};
  },[]);
  if(state==='checking')return <main className="auth-shell"><p role="status">Sitzung wird geprüft …</p></main>;
  if(state==='anonymous')return <Navigate to="/login" replace />;
  return <Layout />;
}

function LoginRoute(){
  return localStorage.getItem('securityops_authenticated')?<Navigate to="/" replace/>:<Login/>;
}

function NotFound(){
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand">SECURITY<span>OPS</span></div><h1>Seite nicht gefunden</h1><p className="muted">Der aufgerufene Bereich existiert nicht oder wurde verschoben.</p><Link className="primary full" to="/">Zur Übersicht</Link></section></main>;
}

export default function App(){
  return <BrowserRouter>
    <Routes>
      <Route path="/login" element={<LoginRoute/>}/>
      <Route element={<ProtectedLayout/>}>
        <Route path="/" element={<NslDashboard/>}/>
        <Route path="/mobile" element={<MobileGuard/>}/>
        <Route path="/watchbook" element={<Watchbook/>}/>
        <Route path="/scheduling" element={<Scheduling/>}/>
        <Route path="/qualifications" element={<Qualifications/>}/>
        <Route path="/dms" element={<Dms/>}/>
        <Route path="/keys" element={<Keys/>}/>
        <Route path="/keys/:keyId" element={<KeyDetail/>}/>
        <Route path="/keys/:keyId/:section" element={<KeyDetail/>}/>
        <Route path="/handovers" element={<Handovers/>}/>
        <Route path="/reports" element={<Reports/>}/>
        <Route path="/customer-reports" element={<CustomerReports/>}/>
        <Route path="/alarm-forwarding" element={<AlarmForwarding/>}/>
        <Route path="/account-security" element={<AccountSecurity/>}/>
        <Route path="/admin" element={<Admin/>}/>
        <Route path="/nfc-devices" element={<NfcDevices/>}/>
        <Route path="/employees" element={<Employees/>}/>
        <Route path="/employees/:employeeId" element={<EmployeeDetail/>}/>
        <Route path="/employees/:employeeId/:section" element={<EmployeeDetail/>}/>
        <Route path="/customers" element={<Customers/>}/>
        <Route path="/customers/:customerId" element={<CustomerDetail/>}/>
        <Route path="/customers/:customerId/:section" element={<CustomerDetail/>}/>
        <Route path="/sites" element={<Sites/>}/>
        <Route path="/sites/:siteId" element={<Sites/>}/>
        <Route path="/sites/:siteId/:section" element={<Sites/>}/>
        <Route path="/devices" element={<Devices/>}/>
        <Route path="/devices/:deviceId" element={<DeviceFile/>}/>
        <Route path="/alarms" element={<Operations/>}/>
        <Route path="/patrols" element={<Patrols/>}/>
        <Route path="/map" element={<LiveMap/>}/>
        <Route path="/telemetry" element={<Telemetry/>}/>
        <Route path="/incidents" element={<Incidents/>}/>
        <Route path="/messages" element={<Messages/>}/>
        <Route path="/notifications" element={<Notifications/>}/>
      </Route>
      <Route path="*" element={<NotFound/>}/>
    </Routes>
  </BrowserRouter>;
}
