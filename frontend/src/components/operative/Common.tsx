import {ReactNode,useEffect} from 'react';
import '../../styles/operative.css';

type Tone='neutral'|'critical'|'high'|'medium'|'low'|'good'|'warning'|'info';

export function Badge({children,tone='neutral',title}:{children:ReactNode;tone?:Tone;title?:string}){
  return <span className={`ops-badge ops-badge-${tone}`} title={title}>{children}</span>;
}

export function LoadingSkeleton({rows=4,label='Daten werden geladen …'}:{rows?:number;label?:string}){
  return <div className="ops-skeleton" role="status" aria-label={label}>
    {Array.from({length:rows},(_,index)=><div className="ops-skeleton-row" key={index}>
      <span/><span/><span/><span/>
    </div>)}
  </div>;
}

export function EmptyState({children='Keine Daten'}:{children?:ReactNode}){
  return <p className="ops-empty" role="status">{children}</p>;
}

export function ErrorState({message,onRetry,label='Erneut laden'}:{message:string;onRetry:()=>void;label?:string}){
  return <div className="ops-error" role="alert">
    <span>{message}</span>
    <button type="button" className="ops-secondary" onClick={onRetry}>{label}</button>
  </div>;
}

export function Section({id,title,description,actions,children}:{
  id?:string;title:string;description?:string;actions?:ReactNode;children:ReactNode;
}){
  return <section className="ops-section" id={id}>
    <div className="ops-section-head">
      <div><h3>{title}</h3>{description&&<p>{description}</p>}</div>
      {actions&&<div className="ops-section-actions">{actions}</div>}
    </div>
    {children}
  </section>;
}

export type TableColumn<T>={
  key:string;
  label:string;
  render:(row:T)=>ReactNode;
};

/** Eine einzige, semantische Tabelle; auf schmalen Displays wird sie per CSS
 *  in Karten umgebaut. So bleiben Inhalte und Statusmeldungen eindeutig. */
export function ResponsiveTable<T>({columns,rows,rowKey,empty='Keine Daten',caption}:{
  columns:TableColumn<T>[];
  rows:T[];
  rowKey:(row:T,index:number)=>string;
  empty?:ReactNode;
  caption?:string;
}){
  if(rows.length===0)return <EmptyState>{empty}</EmptyState>;
  return <div className="ops-table-wrap">
    <table className="ops-table">
      {caption&&<caption>{caption}</caption>}
      <thead><tr>{columns.map(column=><th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map((row,index)=><tr key={rowKey(row,index)}>
        {columns.map(column=><td data-label={column.label} key={column.key}>{column.render(row)}</td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Pagination({page,pages,total,onChange,label='Einträge'}:{
  page:number;pages:number;total:number|null;onChange:(page:number)=>void;label?:string;
}){
  const current=Math.max(1,page);
  const last=Math.max(current,pages);
  return <div className="ops-pagination" aria-label="Seitennavigation">
    <span aria-live="polite">{total===null?`Seite ${current} von ${last}`:`${total} ${label} · Seite ${current} von ${last}`}</span>
    <div className="ops-pagination-buttons">
      <button type="button" className="ops-secondary" disabled={current<=1} onClick={()=>onChange(current-1)}>Zurück</button>
      <button type="button" className="ops-secondary" disabled={current>=last} onClick={()=>onChange(current+1)}>Weiter</button>
    </div>
  </div>;
}

export function Modal({title,children,onClose,wide=false,subtitle}:{
  title:string;children:ReactNode;onClose:()=>void;wide?:boolean;subtitle?:string;
}){
  useEffect(()=>{
    const handler=(event:KeyboardEvent)=>{if(event.key==='Escape')onClose();};
    window.addEventListener('keydown',handler);
    return ()=>window.removeEventListener('keydown',handler);
  },[onClose]);
  return <div className="ops-modal-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget)onClose();}}>
    <section className={wide?'ops-modal wide':'ops-modal'} role="dialog" aria-modal="true" aria-label={title}>
      <header className="ops-modal-head">
        <div><h3>{title}</h3>{subtitle&&<p>{subtitle}</p>}</div>
        <button type="button" className="ops-secondary" onClick={onClose} aria-label="Dialog schließen">Schließen</button>
      </header>
      <div className="ops-modal-body">{children}</div>
    </section>
  </div>;
}

export function Meta({label,value}:{label:string;value:ReactNode}){
  return <div className="ops-meta"><dt>{label}</dt><dd>{value??'–'}</dd></div>;
}
