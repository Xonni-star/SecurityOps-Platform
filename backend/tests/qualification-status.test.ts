import {describe,expect,it} from '@jest/globals';
import {
  classifyQualification,
  daysUntil,
  evidenceStatusOf,
  qualificationDayNumber,
  qualificationLocalDate,
  type QualificationStatusInput,
} from '../src/services/qualification-status.js';

const now=new Date('2026-03-01T12:00:00Z'); // Berlin: 2026-03-01

function classify(overrides:Partial<QualificationStatusInput>={}){
  return classifyQualification({storedStatus:'valid',validFrom:'2025-01-01',validUntil:'2026-12-31',now,...overrides});
}

describe('qualification status: zentrale Qualifikationsklassifikation',()=>{
  it('weist eine gültige Qualifikation ohne Nachweispflicht als gültig aus',()=>{
    expect(classify()).toEqual({status:'valid',label:'Gültig',days_until_expiry:305,issue_code:'none'});
  });

  it('kennzeichnet genau 90 Tage Restlaufzeit als expiring und 91 Tage als gültig',()=>{
    expect(classify({validUntil:'2026-05-30'})).toMatchObject({status:'expiring',days_until_expiry:90,issue_code:'expiring'});
    expect(classify({validUntil:'2026-05-31'})).toMatchObject({status:'valid',days_until_expiry:91,issue_code:'none'});
  });

  it('behandelt abgelaufene und explizit als abgelaufen markierte Qualifikationen als expired',()=>{
    expect(classify({validUntil:'2026-02-28'})).toMatchObject({status:'expired',days_until_expiry:-1,issue_code:'expired'});
    expect(classify({storedStatus:'expired',validUntil:'2027-01-01'})).toMatchObject({status:'expired',issue_code:'expired'});
  });

  it('meldet eine noch nicht wirksame Qualifikation als not_yet_valid',()=>{
    expect(classify({validFrom:'2026-03-02',validUntil:'2027-03-01'})).toMatchObject({status:'not_yet_valid',days_until_expiry:365,issue_code:'not_yet_valid'});
  });

  it('lässt gespeicherten oder time-basierten Widerruf nie als gültig durch',()=>{
    expect(classify({storedStatus:'revoked'})).toMatchObject({status:'revoked',issue_code:'revoked'});
    expect(classify({revokedAt:'2026-02-01T00:00:00Z'})).toMatchObject({status:'revoked',issue_code:'revoked'});
  });

  it('meldet inaktive Katalogeinträge und ungültige Datensätze als invalid',()=>{
    expect(classify({storedStatus:'invalid'})).toMatchObject({status:'invalid',issue_code:'invalid'});
    expect(classify({catalogActive:false})).toMatchObject({status:'invalid',issue_code:'invalid'});
    expect(classify({catalogActive:true})).toMatchObject({status:'valid'});
  });

  it('verlangt bei Nachweispflicht einen vorhandenen Nachweis',()=>{
    for(const evidenceStatus of [undefined,null,'','missing','not_found']){
      expect(classify({requiresEvidence:true,evidenceStatus})).toMatchObject({status:'missing_evidence',issue_code:'missing_evidence'});
    }
    expect(classify({requiresEvidence:false,evidenceStatus:null})).toMatchObject({status:'valid'});
  });

  it('meldet einen nicht freigegebenen oder in Prüfung befindlichen Nachweis als awaiting_review',()=>{
    for(const evidenceStatus of ['nicht_freigegeben','pruefung_ausstehend']){
      expect(classify({requiresEvidence:true,evidenceStatus})).toMatchObject({status:'awaiting_review',issue_code:'unapproved_evidence'});
    }
  });

  it('meldet einen abgelaufenen Nachweis als expired mit issue_code expired_evidence',()=>{
    for(const evidenceStatus of ['abgelaufen','noch_nicht_gueltig']){
      expect(classify({requiresEvidence:true,evidenceStatus})).toMatchObject({status:'expired',issue_code:'expired_evidence'});
    }
    expect(classify({requiresEvidence:true,evidenceStatus:'gueltig',validUntil:'2026-12-31'})).toMatchObject({status:'valid',issue_code:'none'});
  });

  it('wendet die Vorrangregelung Widerruf > ungültig > abgelaufen > Nachweis an',()=>{
    expect(classify({storedStatus:'revoked',validUntil:'2020-01-01',requiresEvidence:true,evidenceStatus:null})).toMatchObject({status:'revoked'});
    expect(classify({catalogActive:false,validUntil:'2020-01-01',requiresEvidence:true,evidenceStatus:'abgelaufen'})).toMatchObject({status:'invalid'});
    expect(classify({validUntil:'2020-01-01',requiresEvidence:true,evidenceStatus:null})).toMatchObject({status:'expired'});
  });
});

describe('qualification status: Berliner Kalendertag und Restlaufzeit',()=>{
  it('rechnet 23:30 UTC bereits auf den nächsten Berliner Kalendertag um',()=>{
    const lateUtc=new Date('2026-03-01T23:30:00Z');
    expect(qualificationLocalDate(lateUtc)).toBe('2026-03-02');
    expect(qualificationLocalDate(new Date('2026-03-01T22:30:00Z'))).toBe('2026-03-01');
    expect(daysUntil('2026-03-02',lateUtc)).toBe(0);
    expect(daysUntil('2026-03-01',lateUtc)).toBe(-1);
    expect(classifyQualification({validUntil:'2026-03-01',now:lateUtc}).status).toBe('expired');
  });

  it('liefert bei fehlendem Ablaufdatum null und rechnet über Monatsgrenzen korrekt',()=>{
    expect(daysUntil(null,now)).toBeNull();
    expect(daysUntil(undefined,now)).toBeNull();
    expect(daysUntil('',now)).toBeNull();
    expect(daysUntil('2026-04-01',now)).toBe(31);
    expect(daysUntil('2027-03-01',now)).toBe(365);
  });
});

describe('qualification status: Nachweisstatus aus DMS-Feldern',()=>{
  it(' erkennt einen freigegebenen, verfügbaren Nachweis als gültig',()=>{
    expect(evidenceStatusOf({
      document_id:'00000000-0000-4000-8000-0000000000b1',
      evidence_document_status:'active',
      evidence_approval_status:'approved',
      evidence_lifecycle_state:'available',
      evidence_valid_until:'2027-01-01',
    },now)).toBe('gueltig');
  });

  it('unterscheidet fehlenden, nicht gefundenen und nicht freigegebenen Nachweis',()=>{
    expect(evidenceStatusOf({document_id:null},now)).toBe('missing');
    expect(evidenceStatusOf({document_id:'doc-1'},now)).toBe('not_found');
    expect(evidenceStatusOf({document_id:'doc-1',evidence_document_status:'deleted',evidence_approval_status:'approved'},now)).toBe('nicht_freigegeben');
    expect(evidenceStatusOf({document_id:'doc-1',evidence_document_status:'active',evidence_approval_status:'pending_approval'},now)).toBe('pruefung_ausstehend');
    expect(evidenceStatusOf({document_id:'doc-1',evidence_document_status:'active',evidence_approval_status:null},now)).toBe('nicht_freigegeben');
    expect(evidenceStatusOf({document_id:'doc-1',evidence_document_status:'active',evidence_approval_status:'approved',evidence_lifecycle_state:'quarantined'},now)).toBe('nicht_freigegeben');
  });

  it('meldet abgelaufene und noch nicht gültige Nachweise an die Klassifikation',()=>{
    const base={document_id:'doc-1',evidence_document_status:'active',evidence_approval_status:'approved',evidence_lifecycle_state:'available'};
    expect(evidenceStatusOf({...base,evidence_valid_until:'2026-02-28'},now)).toBe('abgelaufen');
    expect(evidenceStatusOf({...base,evidence_valid_from:'2026-03-02'},now)).toBe('noch_nicht_gueltig');
    expect(classify({requiresEvidence:true,evidenceStatus:evidenceStatusOf({...base,evidence_valid_until:'2026-02-28'},now)??undefined})).toMatchObject({status:'expired',issue_code:'expired_evidence'});
  });
});

describe('qualification status: malformed dates und Nachweisprüfung',()=>{
  it('fällt bei unvollständigen oder unmöglichen Datumswerten nicht auf heute zurück',()=>{
    for(const invalid of ['2026-02-30','2026-13-01','2026-00-10','kein-datum','2026-01-01T99:00:00Z']){
      expect(qualificationDayNumber(invalid)).toBeNull();
      expect(daysUntil(invalid,now)).toBeNull();
    }
    expect(classify({validUntil:'2026-02-30'})).toMatchObject({status:'invalid',issue_code:'invalid_date'});
    expect(classify({validFrom:'kein-datum'})).toMatchObject({status:'invalid',issue_code:'invalid_date'});
    expect(classify({storedStatus:'revoked',validUntil:'2026-02-30'})).toMatchObject({status:'invalid',issue_code:'invalid_date'});
  });

  it('behandelt ungültige Nachweisdaten und bald prüfpflichtige Nachweise als Prüfbedarf',()=>{
    const base={document_id:'doc-1',evidence_document_status:'active',evidence_approval_status:'approved',evidence_lifecycle_state:'available'};
    expect(evidenceStatusOf({...base,evidence_valid_until:'2026-02-30'},now)).toBe('invalid_date');
    expect(classify({requiresEvidence:true,evidenceStatus:'invalid_date'})).toMatchObject({status:'invalid',issue_code:'invalid_date'});
    expect(classify({requiresEvidence:true,evidenceStatus:'bald_pruefpflichtig'})).toMatchObject({status:'awaiting_review',issue_code:'unapproved_evidence'});
    expect(classify({requiresEvidence:true,evidenceStatus:'lauf_bald_ab'})).toMatchObject({status:'valid',issue_code:'none'});
  });

  it('bleibt an den DST-Grenzen 2026-03-29 und 2026-10-25 auf dem Berliner Kalendertag',()=>{
    const springStart=new Date('2026-03-28T23:30:00Z'); // Berlin: 2026-03-29 00:30
    expect(qualificationLocalDate(springStart)).toBe('2026-03-29');
    expect(daysUntil('2026-03-29',springStart)).toBe(0);
    expect(classify({validUntil:'2026-03-28',now:springStart}).status).toBe('expired');

    const autumnStart=new Date('2026-10-24T22:30:00Z'); // Berlin: 2026-10-25 00:30
    const autumnEnd=new Date('2026-10-25T23:30:00Z'); // Berlin: 2026-10-26 00:30
    expect(qualificationLocalDate(autumnStart)).toBe('2026-10-25');
    expect(qualificationLocalDate(autumnEnd)).toBe('2026-10-26');
    expect(daysUntil('2026-10-25',autumnStart)).toBe(0);
    expect(daysUntil('2026-10-25',autumnEnd)).toBe(-1);
    expect(classify({validUntil:'2026-10-25',now:autumnEnd}).status).toBe('expired');
  });
});
