import {useEffect,useState} from 'react';
import {api} from '../lib/api';
import {formatDateTime,formatNumber} from '../lib/format';
import {statusLabel} from '../lib/status';

type Stats={
  alarms:{total:number;resolved:number;open:number};
  incidents:{total:number;completed:number};
  patrols:{total:number;deviations:number};
  work_time:{minutes:number;entries:number};
  employees:{total:number;active:number;inactive:number};
  qualifications:{total:number;expired:number;expiring:number};
  absences:{total:number;current:number};
};
type WorkTime={
  id:string;
  external_id:string;
  started_at:string;
  ended_at:string|null;
  minutes:number;
  status:string;
  employee_name:string|null;
};

const exportKinds:{kind:string;label:string}[]=[
  {kind:'employees',label:'Mitarbeiter'},
  {kind:'sites',label:'Objekte'},
  {kind:'patrols',label:'Kontrollgänge'},
  {kind:'alarms',label:'Alarme'},
  {kind:'incidents',label:'Einsätze'},
  {kind:'work-time',label:'Arbeitszeiten'},
];

export function Reports(){
  const [stats,setStats]=useState<Stats|null>(null);
  const [entries,setEntries]=useState<WorkTime[]>([]);
  const [error,setError]=useState('');

  useEffect(()=>{
    Promise.all([
      api<Stats>('/reports/statistics'),
      api<WorkTime[]>('/reports/work-time?format=json'),
    ]).then(([summary,rows])=>{
      if(summary)setStats(summary);
      setEntries(Array.isArray(rows)?rows:[]);
    }).catch(cause=>setError((cause as Error).message));
  },[]);

  return <section>
    <h1>Auswertungen und Statistik</h1>
    <p>Kennzahlen zu Alarmen, Einsätzen, Arbeitszeiten und Personal auf einen Blick.</p>
    {error&&<p role="alert">{error}</p>}
    <div className="stats-grid">
      {stats&&<>
        <article><strong>Alarme</strong><p>{formatNumber(stats.alarms.total)} gesamt · {formatNumber(stats.alarms.open)} offen · {formatNumber(stats.alarms.resolved)} erledigt</p></article>
        <article><strong>Einsätze</strong><p>{formatNumber(stats.incidents.total)} gesamt · {formatNumber(stats.incidents.completed)} abgeschlossen</p></article>
        <article><strong>Kontrollgänge</strong><p>{formatNumber(stats.patrols.total)} Kontrollen · {formatNumber(stats.patrols.deviations)} Abweichungen</p></article>
        <article><strong>Arbeitszeit</strong><p>{formatNumber(stats.work_time.minutes)} Minuten aus {formatNumber(stats.work_time.entries)} Einträgen</p></article>
        <article><strong>Mitarbeiter</strong><p>{formatNumber(stats.employees.total)} gesamt · {formatNumber(stats.employees.active)} aktiv · {formatNumber(stats.employees.inactive)} inaktiv</p></article>
        <article><strong>Qualifikationen</strong><p>{formatNumber(stats.qualifications.expiring)} laufen aus · {formatNumber(stats.qualifications.expired)} abgelaufen</p></article>
        <article><strong>Abwesenheiten</strong><p>{formatNumber(stats.absences.current)} aktuell · {formatNumber(stats.absences.total)} erfasst</p></article>
      </>}
    </div>
    <h2>Arbeitszeiten aus TimeScan</h2>
    {entries.length===0
      ? <p>Keine Arbeitszeitdaten im ausgewählten Zeitraum.</p>
      : <table>
          <thead><tr><th>Mitarbeiter</th><th>Beginn</th><th>Ende</th><th>Minuten</th><th>Status</th></tr></thead>
          <tbody>{entries.map(entry=><tr key={entry.id}>
            <td>{entry.employee_name||'Nicht zugeordnet'}</td>
            <td>{formatDateTime(entry.started_at)}</td>
            <td>{entry.ended_at?formatDateTime(entry.ended_at):'–'}</td>
            <td>{formatNumber(entry.minutes)}</td>
            <td>{statusLabel(entry.status)}</td>
          </tr>)}</tbody>
        </table>}
    <h2>Exporte</h2>
    <ul>{exportKinds.map(({kind,label})=><li key={kind}>
      {label}:
      {' '}<a href={`/api/v1/reports/${kind}?format=csv`} target="_blank" rel="noreferrer">CSV-Datei</a>
      {' · '}<a href={`/api/v1/reports/${kind}?format=pdf`} target="_blank" rel="noreferrer">PDF-Datei</a>
    </li>)}</ul>
  </section>;
}
