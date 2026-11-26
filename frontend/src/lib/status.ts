// Einheitliches deutsches Statusvokabular für die gesamte Oberfläche.
// Die technischen Enums bleiben unverändert; diese Zuordnung dient nur der
// Darstellung. Kontextabhängige Begriffe werden über die Domain getrennt.

export type StatusDomain =
  | 'general'
  | 'alarm'
  | 'incident'
  | 'device'
  | 'nfc'
  | 'document'
  | 'documentCategory'
  | 'key'
  | 'keyType'
  | 'condition'
  | 'movement'
  | 'lossStatus'
  | 'employment'
  | 'absence'
  | 'site'
  | 'customer'
  | 'scheduling'
  | 'conflict'
  | 'shiftRole'
  | 'delivery'
  | 'task'
  | 'priority'
  | 'risk'
  | 'role'
  | 'channel'
  | 'sensor';

const general: Record<string, string> = {
  active: 'Aktiv',
  inactive: 'Inaktiv',
  enabled: 'Aktiviert',
  disabled: 'Deaktiviert',
  pending: 'Ausstehend',
  requested: 'Beantragt',
  approved: 'Genehmigt',
  rejected: 'Abgelehnt',
  cancelled: 'Storniert',
  expired: 'Abgelaufen',
  revoked: 'Widerrufen',
  valid: 'Gültig',
  invalid: 'Ungültig',
  archived: 'Archiviert',
  draft: 'Entwurf',
  open: 'Offen',
  closed: 'Geschlossen',
  resolved: 'Behoben',
  acknowledged: 'Bestätigt',
  completed: 'Abgeschlossen',
  in_progress: 'In Bearbeitung',
  planned: 'Geplant',
  overdue: 'Überfällig',
  missed: 'Verpasst',
  available: 'Verfügbar',
  unavailable: 'Nicht verfügbar',
  assigned: 'Zugewiesen',
  unassigned: 'Nicht zugewiesen',
  not_assigned: 'Nicht zugewiesen',
  paused: 'Pausiert',
  ended: 'Beendet',
  terminated: 'Beendet',
  lost: 'Verloren',
  blocked: 'Gesperrt',
  replaced: 'Ersetzt',
  issued: 'Ausgegeben',
  partial: 'Teilweise ausgegeben',
  deactivated: 'Deaktiviert',
  released: 'Freigegeben',
  quarantined: 'In Quarantäne',
  published: 'Veröffentlicht',
  in_review: 'In Prüfung',
  pending_approval: 'Freigabe ausstehend',
  termination_received: 'Kündigung eingegangen',
  expiring: 'Läuft ab',
  on_hold: 'Zurückgestellt',
  failed: 'Fehlgeschlagen',
  success: 'Erfolgreich',
  succeeded: 'Erfolgreich',
  unknown: 'Unbekannt',
  mitigating: 'In Bearbeitung',
  mitigated: 'Gemindert',
  accepted: 'Akzeptiert',
  confirmed: 'Bestätigt',
  unconfirmed: 'Unbestätigt',
  not_configured: 'Nicht konfiguriert',
  configured: 'Konfiguriert',
  verified: 'Überprüft',
  running: 'Läuft',
  never: 'Noch kein Lauf',
  imported: 'Importiert',
  adjusted: 'Korrigiert',
  deleted: 'Gelöscht',
  scan: 'Kontrolle',
  voided: 'Entwertet',
  outgoing: 'Abgebend',
  incoming: 'Übernehmend',
  witness: 'Zeuge',
  'gültig': 'Gültig',
  'läuft bald ab': 'Läuft bald ab',
  'abgelaufen': 'Abgelaufen',
  'keine Daten': 'Keine Daten',
};

const domainLabels: Record<StatusDomain, Record<string, string>> = {
  general,
  alarm: {
    open: 'Offen',
    acknowledged: 'Quittiert',
    escalated: 'Eskaliert',
    mitigating: 'In Bearbeitung',
    mitigated: 'Gemindert',
    resolved: 'Erledigt',
    closed: 'Geschlossen',
  },
  incident: {
    initiated: 'Eingeleitet',
    en_route: 'Auf Anfahrt',
    on_site: 'Vor Ort',
    completed: 'Abgeschlossen',
    cancelled: 'Abgebrochen',
  },
  device: {
    active: 'Aktiv',
    online: 'Online',
    offline: 'Offline',
    maintenance: 'In Wartung',
    operational: 'Betriebsbereit',
    fault: 'Störung',
    out_of_order: 'Außer Betrieb',
    decommissioned: 'Stillgelegt',
  },
  nfc: {
    active: 'Aktiv',
    blocked: 'Gesperrt',
    assigned: 'Zugewiesen',
    unassigned: 'Nicht zugewiesen',
    lost: 'Verloren',
    replaced: 'Ersetzt',
  },
  key: {
    available: 'Verfügbar',
    issued: 'Ausgegeben',
    overdue: 'Überfällig',
    lost: 'Verloren',
    blocked: 'Gesperrt',
    deactivated: 'Deaktiviert',
    partial: 'Teilweise ausgegeben',
  },
  keyType: {
    physical: 'Physisch',
    master: 'Hauptschlüssel',
    transponder: 'Transponder',
    access_card: 'Zutrittskarte',
    electronic: 'Elektronisch',
    digital: 'Digital',
    other: 'Sonstiges',
  },
  condition: {
    good: 'Gut',
    damaged: 'Beschädigt',
    incomplete: 'Unvollständig',
    nonfunctional: 'Funktionslos',
    suspicious_change: 'Verdächtige Veränderung',
  },
  movement: {
    created: 'Angelegt',
    item_added: 'Schlüssel hinzugefügt',
    issued: 'Ausgegeben',
    partial_return: 'Teilweise zurückgegeben',
    returned: 'Zurückgegeben',
    reported_lost: 'Verlust gemeldet',
    lost: 'Verloren',
    blocked: 'Gesperrt',
    reactivated: 'Reaktiviert',
    updated: 'Geändert',
    inventory_check: 'Bestandskontrolle',
    bundle_issued: 'Schlüsselbund ausgegeben',
    bundle_returned: 'Schlüsselbund zurückgegeben',
  },
  lossStatus: {
    reported: 'Gemeldet',
    review: 'In Prüfung',
    security_measure_required: 'Sicherheitsmaßnahme erforderlich',
    replacement_required: 'Ersatz erforderlich',
    closed: 'Abgeschlossen',
  },
  documentCategory: {
    contract: 'Vertrag',
    service: 'Leistung',
    insurance: 'Versicherung',
    security_plan: 'Sicherheitskonzept',
    correspondence: 'Korrespondenz',
    qualification: 'Qualifikation',
    training: 'Fortbildung',
    instruction: 'Unterweisung',
    personal: 'Personalakte',
    other: 'Sonstiges',
  },
  document: {
    quarantined: 'In Quarantäne',
    scanning: 'In Prüfung',
    available: 'Freigegeben',
    released: 'Freigegeben',
    archived: 'Archiviert',
    draft: 'Entwurf',
    invalid: 'Ungültig',
  },
  employment: {
    permanent: 'Unbefristet',
    fixed_term: 'Befristet',
    probation: 'In Probezeit',
    employee: 'Mitarbeiter',
    temporary: 'Aushilfe',
    contractor: 'Fremdpersonal',
    intern: 'Praktikant',
    apprentice: 'Auszubildender',
    freelancer: 'Freiberufler',
    leave: 'Beurlaubt',
    active: 'Aktiv',
    inactive: 'Inaktiv',
    terminated: 'Beendet',
  },
  absence: {
    vacation: 'Urlaub',
    sick: 'Krankheit',
    training: 'Fortbildung',
    special_leave: 'Sonderurlaub',
    compensatory: 'Ausgleichszeit',
    other: 'Sonstiges',
    planned: 'Geplant',
    approved: 'Genehmigt',
    rejected: 'Abgelehnt',
  },
  site: {
    planning: 'In Planung',
    setup: 'Im Aufbau',
    active: 'Aktiv',
    inactive: 'Inaktiv',
    restricted: 'Eingeschränkt',
    temporarily_closed: 'Vorübergehend geschlossen',
    decommissioned: 'Außer Betrieb',
  },
  customer: {
    prospect: 'Interessent',
    negotiating: 'In Verhandlung',
    active: 'Aktiv',
    inactive: 'Inaktiv',
    at_risk: 'Gefährdet',
    primary: 'Hauptstandort',
    branch: 'Niederlassung',
    operational: 'Operativ',
    billing: 'Abrechnung',
    manual: 'Manuell',
    automatic: 'Automatisch',
  },
  scheduling: {
    draft: 'Entwurf',
    published: 'Veröffentlicht',
    closed: 'Abgeschlossen',
    planned: 'Geplant',
    in_progress: 'In Bearbeitung',
    completed: 'Abgeschlossen',
    cancelled: 'Storniert',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    critical: 'Kritisch',
    understaffed: 'Unterbesetzt',
    overstaffed: 'Überbesetzt',
    qualification_mismatch: 'Qualifikation nicht erfüllt',
    rest_violation: 'Ruhezeit nicht eingehalten',
  },
  conflict: {
    error: 'Fehler',
    warning: 'Warnung',
    overlapping_shift: 'Schichtüberschneidung',
    missing_qualification: 'Fehlende Qualifikation',
    absence: 'Abwesenheit',
    rule_profile: 'Regelprofil nicht eingehalten',
  },
  shiftRole: {
    night_guard: 'Nachtwache',
    day_guard: 'Tagwache',
    guard: 'Wachdienst',
    NACHT: 'Nachtwache',
    TAG: 'Tagwache',
  },
  risk: {
    unknown: 'Nicht bewertet',
    low: 'Niedrig',
    medium: 'Mittel',
    high: 'Hoch',
    critical: 'Kritisch',
  },
  task: {
    open: 'Offen',
    in_progress: 'In Bearbeitung',
    completed: 'Erledigt',
    cancelled: 'Abgebrochen',
    overdue: 'Überfällig',
  },
  delivery: {
    queued: 'Übermittlung gestartet',
    forwarded: 'Übermittlung erfolgreich',
    acknowledged: 'Quittierung eingegangen',
    failed: 'Übermittlung fehlgeschlagen',
    exhausted: 'Endgültig fehlgeschlagen',
  },
  priority: {
    low: 'Niedrig',
    normal: 'Normal',
    medium: 'Mittel',
    high: 'Hoch',
    critical: 'Kritisch',
    none: 'Keine',
  },
  role: {
    admin: 'Administrator',
    superadmin: 'Systemadministrator',
    operator: 'Disponent',
    viewer: 'Betrachter',
  },
  channel: {
    in_app: 'In-App',
    email: 'E-Mail',
    sms: 'SMS',
    webhook: 'Webhook',
  },
  sensor: {
    fall: 'Sturzerkennung',
    posture: 'Haltungserkennung',
    inactivity: 'Bewegungslosigkeit',
    battery: 'Batteriestand',
  },
};

export function statusLabel(
  value: string | null | undefined,
  domain: StatusDomain = 'general',
): string {
  if (value === null || value === undefined || String(value).trim() === '') {
    return domain === 'nfc' || domain === 'general' ? 'Nicht zugewiesen' : 'Nicht verfügbar';
  }
  const key = String(value).trim();
  const labels = domainLabels[domain];
  if (labels[key]) return labels[key];
  if (general[key]) return general[key];
  const humanized = key.replace(/_/g, ' ').replace(/-/g, ' ').trim();
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

export function roleLabel(value: string | null | undefined): string {
  return statusLabel(value, 'role');
}

export function priorityLabel(value: string | null | undefined): string {
  return statusLabel(value, 'priority');
}

export function riskLabel(value: string | null | undefined): string {
  return statusLabel(value, 'risk');
}
