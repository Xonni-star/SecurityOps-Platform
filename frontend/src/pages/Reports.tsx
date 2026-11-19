import {useEffect,useState} from 'react';
import {api} from '../lib/api';
type Stats={alarms:{total:number;resolved:number;open:number};incidents:{total:number;completed:number};patrols:{total:number;deviations:number};work_time:{minutes:number;entries:number}};
export function Reports(){
  const [stats,setStats]=useState<Stats|null>(null);const [error,setError]=useState('');
  useEffect(()=>{api<Stats>('/reports/statistics').then(value=>{if(value)setStats(value)}).catch(e=>setError(e.message));},[]);
  return <section><h1>Reporting & Statistik</h1>{error&&<p role="alert">{error}</p>}<div className="stats-grid">{stats&&<><article><strong>Alarme</strong><p>{stats.alarms.total} gesamt · {stats.alarms.open} offen · {stats.alarms.resolved} erledigt</p></article><article><strong>Einsätze</strong><p>{stats.incidents.total} gesamt · {stats.incidents.completed} abgeschlossen</p></article><article><strong>Kontrollgänge</strong><p>{stats.patrols.total} Scans · {stats.patrols.deviations} Abweichungen</p></article><article><strong>Arbeitszeit</strong><p>{stats.work_time.minutes} Minuten aus {stats.work_time.entries} Einträgen</p></article></>}</div><h2>Exporte</h2><ul>{['employees','sites','patrols','alarms','incidents','work-time'].map(kind=><li key={kind}><a href={`/api/v1/reports/${kind}?format=csv`} target="_blank" rel="noreferrer">{kind} CSV</a> · <a href={`/api/v1/reports/${kind}?format=pdf`} target="_blank" rel="noreferrer">PDF</a></li>)}</ul></section>;
}
