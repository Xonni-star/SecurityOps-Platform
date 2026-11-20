import {BrowserRouter,Routes,Route,Navigate} from 'react-router-dom';
import {Layout} from './components/Layout';
import {Login} from './pages/Login';
import {Resource} from './pages/Resource';
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
import {Handovers} from './pages/Handovers';
import {Qualifications} from './pages/Qualifications';

const Protected=({children}:{children:React.ReactNode})=>localStorage.getItem('securityops_authenticated')?<Layout>{children}</Layout>:<Navigate to="/login" replace/>;

export default function App(){
  return <BrowserRouter><Routes><Route path="/login" element={<Login/>}/><Route path="/*" element={<Protected><Routes>
    <Route path="/" element={<NslDashboard/>}/><Route path="/mobile" element={<MobileGuard/>}/><Route path="/watchbook" element={<Watchbook/>}/><Route path="/scheduling" element={<Scheduling/>}/><Route path="/qualifications" element={<Qualifications/>}/><Route path="/dms" element={<Dms/>}/><Route path="/keys" element={<Keys/>}/><Route path="/handovers" element={<Handovers/>}/>
    <Route path="/reports" element={<Reports/>}/><Route path="/admin" element={<Admin/>}/><Route path="/nfc-devices" element={<NfcDevices/>}/>
    <Route path="/employees" element={<Resource name="employees" fields={['name','email','title']}/>}/><Route path="/customers" element={<Resource name="customers" fields={['name','email']}/>}/>
    <Route path="/sites" element={<Resource name="sites" fields={['name','address']}/>}/><Route path="/devices" element={<Resource name="devices" fields={['name','status','site_id']}/>}/>
    <Route path="/alarms" element={<Operations/>}/><Route path="/patrols" element={<Patrols/>}/><Route path="/map" element={<LiveMap/>}/>
    <Route path="/telemetry" element={<Telemetry/>}/><Route path="/incidents" element={<Incidents/>}/><Route path="/messages" element={<Messages/>}/><Route path="/notifications" element={<Notifications/>}/>
  </Routes></Protected>}/></Routes></BrowserRouter>;
}
