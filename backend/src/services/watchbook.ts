export type WatchbookStatus='open'|'closed';

export interface WatchbookRevisionState {
  categoryId:string;
  priorityId:string;
  content:string;
  status:WatchbookStatus;
}

export function mergeCorrection(
  current:WatchbookRevisionState,
  correction:Partial<WatchbookRevisionState>,
):WatchbookRevisionState {
  const next={...current,...correction};
  if(current.status==='closed'&&next.status==='open'){
    const error=Object.assign(new Error('Geschlossene Wachbucheinträge können nicht wieder geöffnet werden.'),{
      status:409,
      code:'WATCHBOOK_INVALID_STATE_TRANSITION',
    });
    throw error;
  }
  if(!next.content.trim())throw new Error('Der Wachbucheintrag darf nicht leer sein.');
  return next;
}
