// Wiederverwendbare deutsche Beschriftungen und Meldungen.
// Fachspezifische Texte bleiben in den jeweiligen Modulen; allgemeine
// Handlungsaufforderungen und Zustände werden hier zentral gepflegt.

import {statusLabel} from './status';

export const commonText = {
  appName: 'SecurityOps',
  loading: 'Wird geladen …',
  noPermission: 'Keine Berechtigung.',
  noData: 'Keine Daten erfasst.',
  notAvailable: 'Nicht verfügbar',
  notAssigned: 'Nicht zugewiesen',
  none: 'Keine',
  save: 'Speichern',
  cancel: 'Abbrechen',
  close: 'Schließen',
  closeFocus: 'Fokus schließen',
  backToOverview: 'Zurück zur Übersicht',
  exportCsv: 'CSV exportieren',
  exportPdf: 'PDF exportieren',
  download: 'Herunterladen',
  changeReason: 'Änderungsgrund',
  reasonRequired: 'Bitte einen Änderungsgrund mit mindestens 3 Zeichen angeben.',
  requestFailed: 'Die Anfrage konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut.',
  saveFailed: 'Die Daten konnten nicht gespeichert werden. Bitte prüfen Sie Ihre Eingaben.',
} as const;

export function requiredUuidMessage(label: string, gender: 'maskulin' | 'feminin' | 'neutral' = 'feminin'): string {
  const article = gender === 'maskulin' ? 'einen gültigen' : gender === 'neutral' ? 'ein gültiges' : 'eine gültige';
  return `Bitte ${article} ${label} angeben.`;
}

const auditDomains: Record<string, string> = {
  absence: 'Abwesenheit',
  alarm: 'Alarm',
  alarms: 'Alarme',
  app: 'Anwendung',
  audit: 'Auditprotokoll',
  authenticated_device: 'Vertrauensgerät',
  authenticated_session: 'Sitzung',
  availability: 'Verfügbarkeit',
  backup: 'Sicherung',
  contact: 'Ansprechpartner',
  contract: 'Vertrag',
  customer: 'Kunde',
  customers: 'Kunden',
  dms: 'Dokumentenverwaltung',
  handover: 'Schichtübergabe',
  incident: 'Einsatz',
  keys: 'Schlüssel',
  maintenance_order: 'Wartungsauftrag',
  message: 'Nachricht',
  mfa: 'Zwei-Faktor-Authentifizierung',
  nfc_device: 'NFC-Gerät',
  notification: 'Benachrichtigung',
  object_assignment: 'Objektzuordnung',
  patrol: 'Kontrollgang',
  position: 'Position',
  privacy: 'Datenschutz',
  profile: 'Profil',
  push_subscription: 'Push-Abonnement',
  qualification: 'Qualifikation',
  report: 'Bericht',
  retention: 'Aufbewahrung',
  scheduling: 'Dienstplanung',
  sensor: 'Sensor',
  site: 'Objekt',
  task: 'Aufgabe',
  timescan: 'TimeScan',
  watchbook: 'Wachbuch',
};

const auditActions: Record<string, string> = {
  acknowledged: 'bestätigt',
  archived: 'archiviert',
  assigned: 'zugewiesen',
  cancelled: 'storniert',
  completed: 'abgeschlossen',
  confirm: 'bestätigt',
  correct: 'korrigiert',
  created: 'angelegt',
  create: 'angelegt',
  deactivate: 'deaktiviert',
  deleted: 'gelöscht',
  enrolled: 'eingerichtet',
  escalated: 'eskaliert',
  exported: 'exportiert',
  failed: 'fehlgeschlagen',
  linked: 'verknüpft',
  lost: 'als verloren gemeldet',
  panic: 'ausgelöst',
  read: 'gelesen',
  reactivate: 'reaktiviert',
  reactivated: 'reaktiviert',
  revoke: 'widerrufen',
  revoked: 'widerrufen',
  resolved: 'erledigt',
  return: 'zurückgegeben',
  returned: 'zurückgegeben',
  return_due: 'Rückgabe angemahnt',
  scan: 'erfasst',
  sent: 'gesendet',
  status_changed: 'Status geändert',
  succeeded: 'erfolgreich',
  sync_completed: 'Synchronisation abgeschlossen',
  updated: 'geändert',
  update: 'geändert',
  verified: 'bestätigt',
};

function humanizeCode(value: string): string {
  const humanized = value.replace(/[._-]/g, ' ').trim();
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

/** Deutsche Bezeichnung eines Audit- oder Verlaufsereignisses. */
export function auditEventLabel(value: string | null | undefined): string {
  if (!value) return commonText.notAvailable;
  const parts = String(value).split('.');
  const domain = auditDomains[parts[0]] ?? humanizeCode(parts[0]);
  if (parts.length === 1) return domain;
  const action = auditActions[parts.slice(1).join('.')] ?? humanizeCode(parts.slice(1).join('.'));
  return `${domain}: ${action}`;
}

const historyDetailLabels: Record<string, string> = {
  actor_email: 'Ausführende Person',
  customer_status: 'Kundenstatus',
  due_at: 'Fällig am',
  is_billing_contact: 'Abrechnungskontakt',
  is_decision_maker: 'Entscheidungsträger',
  is_emergency_contact: 'Notfallkontakt',
  is_primary: 'Primärkontakt',
  is_security_contact: 'Sicherheitskontakt',
  issued_at: 'Ausgegeben am',
  key_type: 'Schlüsseltyp',
  priority: 'Priorität',
  reason: 'Grund',
  risk_classification: 'Risikoklassifizierung',
  status: 'Status',
};

/** Deutsche Darstellung eines einzelnen Verlaufsdetails. */
export function historyDetailText(key: string, value: unknown): string {
  const label = historyDetailLabels[key] ?? auditDomains[key] ?? humanizeCode(key);
  if (typeof value === 'boolean') return `${label}: ${value ? 'Ja' : 'Nein'}`;
  if (value === null || value === undefined || value === '') return `${label}: ${commonText.notAvailable}`;
  const text = String(value);
  const displayValue = /^[a-z_]+$/i.test(text) ? statusLabel(text) : text;
  return `${label}: ${displayValue}`;
}
