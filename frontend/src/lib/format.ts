// Zentrale deutsche Formatierung für alle benutzersichtbaren Datums-, Zeit-,
// Zahlen- und Währungsangaben. Technische Werte bleiben unverändert; die
// Formatierung erfolgt ausschließlich bei der Darstellung.

const locale = 'de-DE';
const timeZone = 'Europe/Berlin';

const dateFormatter = new Intl.DateTimeFormat(locale, {
  timeZone,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat(locale, {
  timeZone,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const timeFormatter = new Intl.DateTimeFormat(locale, {
  timeZone,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const numberFormatter = new Intl.NumberFormat(locale, {
  maximumFractionDigits: 2,
});

const currencyFormatter = new Intl.NumberFormat(locale, {
  style: 'currency',
  currency: 'EUR',
});

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateFormatter.format(date) : '–';
}

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '–';
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date ? timeFormatter.format(date) : '–';
}

export function formatNumber(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? numberFormatter.format(value) : '–';
}

export function formatCurrency(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? currencyFormatter.format(value) : '–';
}

function berlinOffsetMinutes(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(instant).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/** Wandelt ein Datumsfeld (TT.MM.JJJJ als JJJJ-MM-TT) in einen UTC-Zeitstempel um. */
export function berlinDateToIso(value: string, endOfDay = false): string {
  const [year, month, day] = value.split('-').map(Number);
  if (!year || !month || !day) return '';
  const naiveUtc = Date.UTC(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0);
  return new Date(naiveUtc - berlinOffsetMinutes(new Date(naiveUtc)) * 60_000).toISOString();
}

/** Wandelt ein lokales Datetime-Local-Feld aus Europe/Berlin in einen UTC-Zeitstempel um. */
export function berlinDateTimeToIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return '';
  const [, year, month, day, hour, minute] = match.map(Number);
  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(naiveUtc - berlinOffsetMinutes(new Date(naiveUtc)) * 60_000).toISOString();
}

/** Aktuelles Datum in Europe/Berlin im Format JJJJ-MM-TT für Datumsfelder. */
export function berlinToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Stellt einen UTC-Zeitstempel für ein Datetime-Local-Feld in Europe/Berlin dar. */
export function isoToBerlinDateTimeLocal(value: string | null | undefined): string {
  const date = toDate(value);
  if (!date) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce<Record<string, string>>((result, part) => {
    if (part.type !== 'literal') result[part.type] = part.value;
    return result;
  }, {});
  const hour = String(Number(parts.hour) % 24).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}
