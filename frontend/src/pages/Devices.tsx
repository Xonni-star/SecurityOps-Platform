import {FormEvent,useCallback,useEffect,useMemo,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {api,hasPermission} from '../lib/api';
import {formatDate,formatDateTime} from '../lib/format';
import {statusLabel} from '../lib/status';
import {auditEventLabel,commonText,historyDetailText} from '../lib/text';
import {uuid} from '../lib/uuid';

type Option = {id: string; name: string};
type Location = Option & {code: string | null; location_type: string; parent_id: string | null};

type Device = {
  id: string;
  name: string;
  status: string | null;
  site_id: string | null;
  site_name?: string | null;
  location_id: string | null;
  location_name?: string | null;
  responsible_employee_id: string | null;
  responsible_employee_name?: string | null;
  asset_number: string | null;
  category: string | null;
  manufacturer: string | null;
  model: string | null;
  serial_number: string | null;
  operational_status: string;
  installed_on: string | null;
  commissioned_on: string | null;
  last_inspection_on: string | null;
  next_inspection_on: string | null;
  inspection_state?: string;
  maintenance_interval_days: number | null;
  last_maintenance_on: string | null;
  next_maintenance_on: string | null;
  effective_maintenance_on?: string | null;
  maintenance_state?: string;
  created_at: string;
  updated_at: string;
};

type Overview = {
  total_devices: number;
  active_devices: number;
  maintenance_devices: number;
  faulty_devices: number;
  offline_devices: number;
  decommissioned_devices: number;
  overdue_inspections: number;
  upcoming_inspections: number;
  overdue_maintenance: number;
  upcoming_maintenance: number;
};

type Inventory = {
  rows: Device[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

type Filters = {
  search: string;
  site_id: string;
  category: string;
  operational_status: string;
  manufacturer: string;
  responsible_employee_id: string;
  inspection_due: string;
  maintenance_due: string;
  sort: string;
  dir: string;
  page: number;
  pageSize: number;
};

const initialFilters: Filters = {
  search: '',
  site_id: '',
  category: '',
  operational_status: '',
  manufacturer: '',
  responsible_employee_id: '',
  inspection_due: '',
  maintenance_due: '',
  sort: 'name',
  dir: 'asc',
  page: 1,
  pageSize: 25,
};

type DeviceForm = {
  name: string;
  status: string;
  asset_number: string;
  category: string;
  manufacturer: string;
  model: string;
  serial_number: string;
  site_id: string;
  location_id: string;
  responsible_employee_id: string;
  operational_status: string;
  installed_on: string;
  commissioned_on: string;
  last_inspection_on: string;
  next_inspection_on: string;
  maintenance_interval_days: string;
  last_maintenance_on: string;
  next_maintenance_on: string;
};

const emptyForm: DeviceForm = {
  name: '',
  status: 'online',
  asset_number: '',
  category: '',
  manufacturer: '',
  model: '',
  serial_number: '',
  site_id: '',
  location_id: '',
  responsible_employee_id: '',
  operational_status: 'active',
  installed_on: '',
  commissioned_on: '',
  last_inspection_on: '',
  next_inspection_on: '',
  maintenance_interval_days: '',
  last_maintenance_on: '',
  next_maintenance_on: '',
};

const operationalStatuses = ['active', 'maintenance', 'fault', 'offline', 'decommissioned'];
const connectionStatuses = ['online', 'offline', 'maintenance'];
const inspectionStates: Record<string, string> = {
  overdue: 'Überfällig',
  soon: 'Bald fällig',
  planned: 'Geplant',
  none: 'Nicht hinterlegt',
};
const maintenanceTypes = ['inspection', 'preventive', 'corrective', 'repair', 'other'];
const maintenanceTypeLabels: Record<string, string> = {
  inspection: 'Prüfung',
  preventive: 'Vorbeugende Wartung',
  corrective: 'Korrektive Wartung',
  repair: 'Reparatur',
  other: 'Sonstige',
};
const priorities = ['critical', 'high', 'medium', 'low'];

function operationalLabel(value: string | null | undefined): string {
  return value ? statusLabel(value, 'device') : commonText.notAvailable;
}

function statusClass(value: string): string {
  if (value === 'active' || value === 'online') return 'active';
  if (value === 'maintenance' || value === 'fault') return 'restricted';
  if (value === 'decommissioned') return 'decommissioned';
  return '';
}

function dateOnly(value?: string | null): string {
  return value ? value.slice(0, 10) : '';
}

function formFromDevice(device: Device): DeviceForm {
  return {
    name: device.name ?? '',
    status: device.status ?? 'online',
    asset_number: device.asset_number ?? '',
    category: device.category ?? '',
    manufacturer: device.manufacturer ?? '',
    model: device.model ?? '',
    serial_number: device.serial_number ?? '',
    site_id: device.site_id ?? '',
    location_id: device.location_id ?? '',
    responsible_employee_id: device.responsible_employee_id ?? '',
    operational_status: device.operational_status ?? 'active',
    installed_on: dateOnly(device.installed_on),
    commissioned_on: dateOnly(device.commissioned_on),
    last_inspection_on: dateOnly(device.last_inspection_on),
    next_inspection_on: dateOnly(device.next_inspection_on),
    maintenance_interval_days: device.maintenance_interval_days ? String(device.maintenance_interval_days) : '',
    last_maintenance_on: dateOnly(device.last_maintenance_on),
    next_maintenance_on: dateOnly(device.next_maintenance_on),
  };
}

function payloadFromForm(form: DeviceForm): Record<string, unknown> {
  const nullable = [
    'asset_number',
    'category',
    'manufacturer',
    'model',
    'serial_number',
    'site_id',
    'location_id',
    'responsible_employee_id',
    'installed_on',
    'commissioned_on',
    'last_inspection_on',
    'next_inspection_on',
    'last_maintenance_on',
    'next_maintenance_on',
  ] as const;
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    status: form.status || 'online',
    operational_status: form.operational_status || 'active',
    maintenance_interval_days: form.maintenance_interval_days ? Number(form.maintenance_interval_days) : null,
  };
  for (const field of nullable) payload[field] = form[field].trim() || null;
  return payload;
}

function validateForm(form: DeviceForm): string {
  if (!form.name.trim()) return 'Bitte eine Gerätebezeichnung angeben.';
  if (
    form.maintenance_interval_days &&
    (!Number.isInteger(Number(form.maintenance_interval_days)) || Number(form.maintenance_interval_days) < 1)
  ) {
    return 'Das Wartungsintervall muss eine ganze Zahl von mindestens 1 Tag sein.';
  }
  if (form.last_inspection_on && form.next_inspection_on && form.next_inspection_on < form.last_inspection_on) {
    return 'Die nächste Prüfung darf nicht vor der letzten Prüfung liegen.';
  }
  return '';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : commonText.requestFailed;
}

function DeviceFormFields({
  form,
  onChange,
  sites,
  employees,
  locations,
  categories,
  manufacturers,
}: {
  form: DeviceForm;
  onChange: (field: keyof DeviceForm, value: string) => void;
  sites: Option[];
  employees: Option[];
  locations: Location[];
  categories: string[];
  manufacturers: string[];
}) {
  const field = (key: keyof DeviceForm, label: string, help?: string) => (
    <label key={key} title={help}>
      {label}
      <input value={form[key]} onChange={event => onChange(key, event.target.value)} />
    </label>
  );
  return (
    <>
      <label title="Eindeutige interne Bezeichnung des Geräts">
        Gerätebezeichnung *
        <input required value={form.name} onChange={event => onChange('name', event.target.value)} />
      </label>
      <label title="Inventarnummer aus dem Anlagenverzeichnis">
        Inventarnummer
        <input value={form.asset_number} onChange={event => onChange('asset_number', event.target.value)} />
      </label>
      <label title="Kategorie des Betriebsgeräts">
        Kategorie
        <input list="device-categories" value={form.category} onChange={event => onChange('category', event.target.value)} />
        <datalist id="device-categories">
          {categories.map(category => <option key={category} value={category} />)}
        </datalist>
      </label>
      <label title="Hersteller des Geräts">
        Hersteller
        <input list="device-manufacturers" value={form.manufacturer} onChange={event => onChange('manufacturer', event.target.value)} />
        <datalist id="device-manufacturers">
          {manufacturers.map(manufacturer => <option key={manufacturer} value={manufacturer} />)}
        </datalist>
      </label>
      {field('model', 'Modell')}
      {field('serial_number', 'Seriennummer', 'Seriennummer des Herstellers')}
      <label title="Objekt, dem das Gerät fest zugeordnet ist">
        Objekt
        <select value={form.site_id} onChange={event => onChange('site_id', event.target.value)}>
          <option value="">Kein Objekt</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label title="Standort oder Bereich innerhalb des Objekts">
        Standort / Bereich
        <select value={form.location_id} onChange={event => onChange('location_id', event.target.value)}>
          <option value="">Gesamtes Objekt</option>
          {locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
      </label>
      <label title="Fachlich verantwortlicher Mitarbeiter">
        Verantwortlicher Mitarbeiter
        <select value={form.responsible_employee_id} onChange={event => onChange('responsible_employee_id', event.target.value)}>
          <option value="">Nicht zugewiesen</option>
          {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>
      <label title="Fachlicher Zustand des Geräts, getrennt von der technischen Erreichbarkeit">
        Betriebsstatus *
        <select value={form.operational_status} onChange={event => onChange('operational_status', event.target.value)}>
          {operationalStatuses.map(value => <option key={value} value={value}>{operationalLabel(value)}</option>)}
        </select>
      </label>
      <label title="Technischer Erreichbarkeitsstatus; nicht mit dem Betriebsstatus verwechseln">
        Technischer Status
        <select value={form.status} onChange={event => onChange('status', event.target.value)}>
          {connectionStatuses.map(value => <option key={value} value={value}>{statusLabel(value, 'device')}</option>)}
        </select>
      </label>
      {field('installed_on', 'Installiert am')}
      {field('commissioned_on', 'Inbetriebnahme am')}
      <label title="Datum der letzten Prüfung">
        Letzte Prüfung
        <input type="date" value={form.last_inspection_on} onChange={event => onChange('last_inspection_on', event.target.value)} />
      </label>
      <label title="Datum der nächsten fälligen Prüfung">
        Nächste Prüfung
        <input type="date" value={form.next_inspection_on} onChange={event => onChange('next_inspection_on', event.target.value)} />
      </label>
      <label title="Abstand zwischen zwei Wartungen in Tagen">
        Wartungsintervall (Tage)
        <input type="number" min="1" step="1" value={form.maintenance_interval_days} onChange={event => onChange('maintenance_interval_days', event.target.value)} />
      </label>
      <label title="Datum der letzten abgeschlossenen Wartung">
        Letzte Wartung
        <input type="date" value={form.last_maintenance_on} onChange={event => onChange('last_maintenance_on', event.target.value)} />
      </label>
      <label title="Nächster Wartungstermin; wird beim Abschluss eines Auftrags automatisch fortgeschrieben">
        Nächste Wartung
        <input type="date" value={form.next_maintenance_on} onChange={event => onChange('next_maintenance_on', event.target.value)} />
      </label>
    </>
  );
}

function KpiCard({label, value, hint, onClick}: {label: string; value: number; hint?: string; onClick?: () => void}) {
  const content = <><strong>{value}</strong><span>{label}</span>{hint && <small>{hint}</small>}</>;
  return onClick ? (
    <article className="object-summary-card" role="button" tabIndex={0} onClick={onClick} onKeyDown={event => {
      if (event.key === 'Enter' || event.key === ' ') onClick();
    }}>{content}</article>
  ) : <article>{content}</article>;
}

function SortButton({field, label, filters, onSort}: {field: string; label: string; filters: Filters; onSort: (field: string) => void}) {
  const marker = filters.sort === field ? (filters.dir === 'asc' ? ' ↑' : ' ↓') : '';
  return <button type="button" onClick={() => onSort(field)}>{label}{marker}</button>;
}

async function loadOptionData() {
  const [sites, employees, options] = await Promise.all([
    api<Option[]>('/sites').catch(() => []),
    hasPermission('employees:read') ? api<Option[]>('/employees').catch(() => []) : Promise.resolve([]),
    api<{categories: string[]; manufacturers: string[]}>('/devices/filter-options').catch(() => ({categories: [], manufacturers: []})),
  ]);
  return {
    sites: Array.isArray(sites) ? sites : [],
    employees: Array.isArray(employees) ? employees : [],
    options: {
      categories: Array.isArray(options?.categories) ? options.categories : [],
      manufacturers: Array.isArray(options?.manufacturers) ? options.manufacturers : [],
    },
  };
}

export function Devices() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(initialFilters);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [inventory, setInventory] = useState<Inventory>({rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1});
  const [sites, setSites] = useState<Option[]>([]);
  const [employees, setEmployees] = useState<Option[]>([]);
  const [options, setOptions] = useState<{categories: string[]; manufacturers: string[]}>({categories: [], manufacturers: []});
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Device | null>(null);
  const [form, setForm] = useState<DeviceForm>(emptyForm);
  const [saving, setSaving] = useState(false);

  const query = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value !== '') params.set(key, String(value));
    return params.toString();
  }, [filters]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [metrics, list] = await Promise.all([
        api<Overview>('/devices/overview'),
        api<Inventory>(`/devices/inventory?${query}`),
      ]);
      setOverview(metrics ?? null);
      setInventory(list && Array.isArray(list.rows)
        ? list
        : {rows: [], total: 0, page: 1, pageSize: 25, totalPages: 1});
    } catch (cause) {
      setError(message(cause));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadOptionData().then(data => {
      setSites(data.sites ?? []);
      setEmployees(data.employees ?? []);
      setOptions(data.options ?? {categories: [], manufacturers: []});
    });
  }, []);
  useEffect(() => {
    if (!form.site_id) { setLocations([]); return; }
    void api<Location[]>(`/devices/locations/${form.site_id}`).then(value => setLocations(Array.isArray(value) ? value : [])).catch(() => setLocations([]));
  }, [form.site_id]);

  function updateFilter(key: keyof Filters, value: string | number) {
    setFilters(current => ({...current, [key]: value, page: key === 'page' ? Number(value) : 1}));
  }

  function sortBy(field: string) {
    setFilters(current => ({
      ...current,
      sort: field,
      dir: current.sort === field && current.dir === 'asc' ? 'desc' : 'asc',
      page: 1,
    }));
  }

  function startCreate() {
    setEditing(null);
    setForm(emptyForm);
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  function startEdit(device: Device) {
    setEditing(device);
    setForm(formFromDevice(device));
    setShowForm(true);
    setError('');
    setSuccess('');
  }

  async function saveDevice(event: FormEvent) {
    event.preventDefault();
    const validation = validateForm(form);
    if (validation) { setError(validation); return; }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const payload = payloadFromForm(form);
      if (editing) await api(`/devices/${editing.id}`, {method: 'PATCH', body: JSON.stringify(payload)});
      else await api('/devices', {method: 'POST', body: JSON.stringify(payload)});
      setShowForm(false);
      setSuccess(editing ? 'Das Gerät wurde gespeichert.' : 'Das Gerät wurde angelegt.');
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  }

  async function archive(device: Device) {
    if (!window.confirm(`Soll „${device.name}“ ausgemustert werden? Der Gerätebestand bleibt revisionssicher erhalten.`)) return;
    try {
      await api(`/devices/${device.id}/archive`, {method: 'POST', body: JSON.stringify({})});
      setSuccess('Das Gerät wurde ausgemustert.');
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  }

  const canWrite = hasPermission('devices:write');

  return <section className="object-management">
    {error && <p className="object-warning" role="alert">{error}</p>}
    {success && <p role="status">{success}</p>}

    <div className="object-page-actions">
      <button type="button" onClick={() => void load()} disabled={loading}>Liste aktualisieren</button>
      {canWrite && <button type="button" onClick={startCreate}>Gerät anlegen</button>}
    </div>

    <div className="object-metrics">
      <KpiCard label="Geräte gesamt" value={overview?.total_devices ?? 0} />
      <KpiCard label="Aktive Geräte" value={overview?.active_devices ?? 0} />
      <KpiCard label="Geräte in Wartung" value={overview?.maintenance_devices ?? 0} />
      <KpiCard label="Defekte Geräte" value={overview?.faulty_devices ?? 0} />
      <KpiCard
        label="Überfällige Prüfungen"
        value={overview?.overdue_inspections ?? 0}
        hint="Klicken zum Filtern"
        onClick={() => updateFilter('inspection_due', 'overdue')}
      />
      <KpiCard
        label="Anstehende Wartungen"
        value={overview?.upcoming_maintenance ?? 0}
        hint="Nächste 30 Tage"
        onClick={() => updateFilter('maintenance_due', 'soon')}
      />
    </div>

    {showForm && <section className="object-detail-content">
      <h3>{editing ? `Gerät bearbeiten: ${editing.name}` : 'Neues Gerät anlegen'}</h3>
      <p className="muted">Der Betriebsstatus beschreibt den fachlichen Zustand. Der technische Status bleibt davon getrennt.</p>
      <form className="object-detail-form" onSubmit={saveDevice}>
        <div className="form-grid">
          <DeviceFormFields
            form={form}
            onChange={(field, value) => setForm(current => ({...current, [field]: value}))}
            sites={sites}
            employees={employees}
            locations={locations}
            categories={options.categories}
            manufacturers={options.manufacturers}
          />
        </div>
        <div className="object-header-meta">
          <button type="submit" disabled={saving}>{saving ? 'Speichern …' : commonText.save}</button>
          <button type="button" onClick={() => setShowForm(false)}>{commonText.cancel}</button>
        </div>
      </form>
    </section>}

    <div className="object-filterbar">
      <label>Suche
        <input
          placeholder="Name, Inventar- oder Seriennummer"
          value={filters.search}
          onChange={event => updateFilter('search', event.target.value)}
        />
      </label>
      <label>Objekt
        <select value={filters.site_id} onChange={event => updateFilter('site_id', event.target.value)}>
          <option value="">Alle Objekte</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label>Kategorie
        <select value={filters.category} onChange={event => updateFilter('category', event.target.value)}>
          <option value="">Alle Kategorien</option>
          {options.categories.map(category => <option key={category} value={category}>{category}</option>)}
        </select>
      </label>
      <label>Betriebsstatus
        <select value={filters.operational_status} onChange={event => updateFilter('operational_status', event.target.value)}>
          <option value="">Alle Status</option>
          {operationalStatuses.map(value => <option key={value} value={value}>{operationalLabel(value)}</option>)}
        </select>
      </label>
      <label>Hersteller
        <select value={filters.manufacturer} onChange={event => updateFilter('manufacturer', event.target.value)}>
          <option value="">Alle Hersteller</option>
          {options.manufacturers.map(manufacturer => <option key={manufacturer} value={manufacturer}>{manufacturer}</option>)}
        </select>
      </label>
      <label>Verantwortlicher
        <select value={filters.responsible_employee_id} onChange={event => updateFilter('responsible_employee_id', event.target.value)}>
          <option value="">Alle Mitarbeiter</option>
          {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>
      <label>Prüfungsfälligkeit
        <select value={filters.inspection_due} onChange={event => updateFilter('inspection_due', event.target.value)}>
          <option value="">Beliebig</option>
          <option value="overdue">Überfällig</option>
          <option value="soon">In 30 Tagen</option>
          <option value="planned">Später</option>
          <option value="none">Nicht hinterlegt</option>
        </select>
      </label>
      <label>Wartungsfälligkeit
        <select value={filters.maintenance_due} onChange={event => updateFilter('maintenance_due', event.target.value)}>
          <option value="">Beliebig</option>
          <option value="overdue">Überfällig</option>
          <option value="soon">In 30 Tagen</option>
          <option value="planned">Später</option>
          <option value="none">Nicht hinterlegt</option>
        </select>
      </label>
    </div>

    {loading ? <p role="status">{commonText.loading}</p> : (
      <div className="object-table">
        <table>
          <thead>
            <tr>
              <th><SortButton field="asset_number" label="Inventarnummer" filters={filters} onSort={sortBy} /></th>
              <th><SortButton field="name" label="Gerätebezeichnung" filters={filters} onSort={sortBy} /></th>
              <th><SortButton field="category" label="Kategorie" filters={filters} onSort={sortBy} /></th>
              <th><SortButton field="manufacturer" label="Hersteller / Modell" filters={filters} onSort={sortBy} /></th>
              <th>Seriennummer</th>
              <th><SortButton field="site" label="Objekt" filters={filters} onSort={sortBy} /></th>
              <th>Standort / Bereich</th>
              <th>Verantwortlicher</th>
              <th><SortButton field="operational_status" label="Betriebsstatus" filters={filters} onSort={sortBy} /></th>
              <th><SortButton field="next_inspection_on" label="Nächste Prüfung" filters={filters} onSort={sortBy} /></th>
              <th><SortButton field="next_maintenance_on" label="Nächste Wartung" filters={filters} onSort={sortBy} /></th>
              <th>Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {inventory.rows.map(device => <tr
              key={device.id}
              tabIndex={0}
              onClick={() => navigate(`/devices/${device.id}`)}
              onKeyDown={event => { if (event.key === 'Enter') navigate(`/devices/${device.id}`); }}
            >
              <td>{device.asset_number ?? '–'}</td>
              <td><strong>{device.name}</strong></td>
              <td>{device.category ?? '–'}</td>
              <td>{[device.manufacturer, device.model].filter(Boolean).join(' / ') || '–'}</td>
              <td>{device.serial_number ?? '–'}</td>
              <td>{device.site_name ?? (device.site_id ? 'Objekt' : 'Kein Objekt')}</td>
              <td>{device.location_name ?? '–'}</td>
              <td>{device.responsible_employee_name ?? '–'}</td>
              <td><span className={`object-status ${statusClass(device.operational_status)}`}>{operationalLabel(device.operational_status)}</span></td>
              <td>{device.next_inspection_on ? formatDate(device.next_inspection_on) : '–'}</td>
              <td>{device.effective_maintenance_on ? formatDate(device.effective_maintenance_on) : '–'}</td>
              <td>
                {canWrite && <button type="button" onClick={event => { event.stopPropagation(); startEdit(device); }}>Bearbeiten</button>}
                {canWrite && <button type="button" onClick={event => { event.stopPropagation(); void archive(device); }}>Ausmustern</button>}
              </td>
            </tr>)}
          </tbody>
        </table>
        {inventory.rows.length === 0 && <p className="object-empty">Keine Geräte für die gewählten Filter erfasst.</p>}
      </div>
    )}

    <div className="object-pagination">
      <button type="button" disabled={filters.page <= 1} onClick={() => updateFilter('page', filters.page - 1)}>Zurück</button>
      <span>Seite {inventory.page} von {inventory.totalPages} · {inventory.total} Geräte</span>
      <button type="button" disabled={filters.page >= inventory.totalPages} onClick={() => updateFilter('page', filters.page + 1)}>Weiter</button>
    </div>
  </section>;
}

type MaintenanceOrder = {
  id: string;
  order_number: string;
  device_id: string;
  device_name: string | null;
  maintenance_type: string;
  description: string;
  priority_code: string;
  due_on: string | null;
  status: string;
  computed_status: string;
  status_label: string;
  overdue: boolean;
  responsible_employee_id: string | null;
  responsible_employee_name: string | null;
  performed_work: string | null;
  result: string | null;
  next_maintenance_on: string | null;
  documents?: {id: string; document_id: string; document_title: string; document_status: string}[];
  created_at: string;
};

type DeviceFileData = {
  device: Device;
  maintenance_orders: MaintenanceOrder[];
  alarms: {id: string; severity: string; status: string; message: string; triggered_at: string; resolved_at: string | null}[];
  documents: {id: string; title: string; document_number: string | null; document_type: string | null; document_status: string; approval_status: string; valid_until: string | null; latest_version_id: string | null; created_at: string}[];
  history: {id: string; event_type: string; entity_type: string; details: Record<string, unknown>; created_at: string}[];
};

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error('Die Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

export function DeviceFile() {
  const {deviceId = ''} = useParams();
  const navigate = useNavigate();
  const [file, setFile] = useState<DeviceFileData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [tab, setTab] = useState('uebersicht');
  const [sites, setSites] = useState<Option[]>([]);
  const [employees, setEmployees] = useState<Option[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [manufacturers, setManufacturers] = useState<string[]>([]);
  const [form, setForm] = useState<DeviceForm>(emptyForm);
  const [inspection, setInspection] = useState({last_inspection_on: '', next_inspection_on: ''});
  const [maintenanceForm, setMaintenanceForm] = useState({
    maintenance_type: 'inspection', description: '', priority_code: 'medium', due_on: '', responsible_employee_id: '',
  });
  const [completionOrderId, setCompletionOrderId] = useState('');
  const [completionText, setCompletionText] = useState('');
  const [cancellationOrderId, setCancellationOrderId] = useState('');
  const [cancellationReason, setCancellationReason] = useState('');
  const [linkOrderId, setLinkOrderId] = useState('');
  const [linkDocumentId, setLinkDocumentId] = useState('');
  const [documentForm, setDocumentForm] = useState({title: '', document_type: '', responsible_employee_id: ''});
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignForm, setAssignForm] = useState({site_id: '', location_id: ''});
  const [responsibleOpen, setResponsibleOpen] = useState(false);
  const [responsibleId, setResponsibleId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api<DeviceFileData>(`/devices/${deviceId}/file`);
      if (!data?.device) throw new Error('Die Geräteakte konnte nicht geladen werden.');
      setFile(data);
      setForm(formFromDevice(data.device));
      setInspection({
        last_inspection_on: dateOnly(data.device.last_inspection_on),
        next_inspection_on: dateOnly(data.device.next_inspection_on),
      });
      setAssignForm({site_id: data.device.site_id ?? '', location_id: data.device.location_id ?? ''});
      setResponsibleId(data.device.responsible_employee_id ?? '');
    } catch (cause) {
      setError(message(cause));
      setFile(null);
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void loadOptionData().then(data => {
      setSites(data.sites ?? []);
      setEmployees(data.employees ?? []);
      setCategories(data.options?.categories ?? []);
      setManufacturers(data.options?.manufacturers ?? []);
    });
  }, []);
  useEffect(() => {
    if (!form.site_id) { setLocations([]); return; }
    void api<Location[]>(`/devices/locations/${form.site_id}`).then(value => setLocations(Array.isArray(value) ? value : [])).catch(() => setLocations([]));
  }, [form.site_id]);
  useEffect(() => {
    if (!assignForm.site_id || assignForm.site_id === form.site_id) return;
    void api<Location[]>(`/devices/locations/${assignForm.site_id}`).then(value => setLocations(Array.isArray(value) ? value : [])).catch(() => setLocations([]));
  }, [assignForm.site_id, form.site_id]);

  const run = async (action: () => Promise<void>, successText: string) => {
    setError('');
    setSuccess('');
    try {
      await action();
      setSuccess(successText);
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };

  async function saveMasterData(event: FormEvent) {
    event.preventDefault();
    const validation = validateForm(form);
    if (validation) { setError(validation); return; }
    await run(async () => {
      await api(`/devices/${deviceId}`, {method: 'PATCH', body: JSON.stringify(payloadFromForm(form))});
    }, 'Die Stammdaten wurden gespeichert.');
  }

  async function updateInspection(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api(`/devices/${deviceId}/inspection`, {
        method: 'POST',
        body: JSON.stringify({
          last_inspection_on: inspection.last_inspection_on || null,
          next_inspection_on: inspection.next_inspection_on || null,
        }),
      });
    }, 'Die Prüfungsdaten wurden gespeichert.');
  }

  async function createMaintenance(event: FormEvent) {
    event.preventDefault();
    if (!file?.device.site_id) { setError('Für Wartungsaufträge muss dem Gerät ein Objekt zugeordnet sein.'); return; }
    await run(async () => {
      await api(`/sites/${file.device.site_id}/maintenance-orders`, {
        method: 'POST',
        headers: {'Idempotency-Key': uuid()},
        body: JSON.stringify({
          device_id: deviceId,
          maintenance_type: maintenanceForm.maintenance_type,
          description: maintenanceForm.description.trim(),
          priority_code: maintenanceForm.priority_code,
          due_on: maintenanceForm.due_on || null,
          responsible_employee_id: maintenanceForm.responsible_employee_id || null,
        }),
      });
      setMaintenanceForm({maintenance_type: 'inspection', description: '', priority_code: 'medium', due_on: '', responsible_employee_id: ''});
    }, 'Der Wartungsauftrag wurde erstellt.');
  }

  async function changeOrderStatus(orderId: string, status: string) {
    await run(async () => {
      await api(`/maintenance-orders/${orderId}`, {method: 'PATCH', body: JSON.stringify({status})});
    }, 'Der Wartungsauftrag wurde aktualisiert.');
  }

  async function completeOrder(event: FormEvent) {
    event.preventDefault();
    if (completionText.trim().length < 3) { setError('Bitte die durchgeführte Arbeit mit mindestens 3 Zeichen beschreiben.'); return; }
    await run(async () => {
      await api(`/maintenance-orders/${completionOrderId}/complete`, {
        method: 'POST', body: JSON.stringify({performed_work: completionText.trim()}),
      });
      setCompletionOrderId('');
      setCompletionText('');
    }, 'Der Wartungsauftrag wurde abgeschlossen.');
  }

  async function cancelOrder(event: FormEvent) {
    event.preventDefault();
    if (cancellationReason.trim().length < 3) { setError('Bitte einen Grund mit mindestens 3 Zeichen angeben.'); return; }
    await run(async () => {
      await api(`/maintenance-orders/${cancellationOrderId}/cancel`, {
        method: 'POST', body: JSON.stringify({reason: cancellationReason.trim()}),
      });
      setCancellationOrderId('');
      setCancellationReason('');
    }, 'Der Wartungsauftrag wurde storniert.');
  }

  async function linkDocument(event: FormEvent) {
    event.preventDefault();
    if (!linkOrderId || !linkDocumentId) { setError('Bitte einen Auftrag und ein Dokument auswählen.'); return; }
    await run(async () => {
      await api(`/maintenance-orders/${linkOrderId}/documents`, {
        method: 'POST', body: JSON.stringify({document_id: linkDocumentId}),
      });
    }, 'Das Dokument wurde mit dem Wartungsauftrag verknüpft.');
  }

  async function uploadDocument(event: FormEvent) {
    event.preventDefault();
    if (!documentFile) { setError('Bitte eine Datei auswählen.'); return; }
    if (!documentForm.title.trim()) { setError('Bitte einen Dokumenttitel angeben.'); return; }
    await run(async () => {
      const content_base64 = await readFileAsBase64(documentFile);
      await api('/dms/documents', {
        method: 'POST',
        body: JSON.stringify({
          title: documentForm.title.trim(),
          document_type: documentForm.document_type.trim() || null,
          device_id: deviceId,
          site_id: file?.device.site_id ?? null,
          responsible_employee_id: documentForm.responsible_employee_id || null,
          content_type: documentFile.type || 'application/pdf',
          content_base64,
          client_mutation_id: uuid(),
        }),
      });
      setDocumentForm({title: '', document_type: '', responsible_employee_id: ''});
      setDocumentFile(null);
    }, 'Das Dokument wurde in der Geräteakte gespeichert.');
  }

  async function downloadDocument(documentId: string, latestVersionId: string) {
    try {
      if (!latestVersionId) throw new Error('Für dieses Dokument ist keine Dateifassung verfügbar.');
      const response = await fetch(`/api/v1/dms/documents/${documentId}/versions/${latestVersionId}/download`, {credentials: 'include'});
      if (!response.ok) throw new Error('Das Dokument konnte nicht heruntergeladen werden.');
      const url = URL.createObjectURL(await response.blob());
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = 'dokument';
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(message(cause));
    }
  }

  async function assignSite(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api(`/devices/${deviceId}/assign-site`, {
        method: 'POST',
        body: JSON.stringify({
          site_id: assignForm.site_id || null,
          location_id: assignForm.location_id || null,
        }),
      });
      setAssignOpen(false);
    }, 'Die Objektzuordnung wurde gespeichert.');
  }

  async function changeResponsible(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api(`/devices/${deviceId}/assign-responsible`, {
        method: 'POST',
        body: JSON.stringify({responsible_employee_id: responsibleId || null}),
      });
      setResponsibleOpen(false);
    }, 'Der verantwortliche Mitarbeiter wurde gespeichert.');
  }

  async function deleteDevice() {
    if (!window.confirm(`Soll „${device?.name ?? 'dieses Gerät'}“ endgültig gelöscht werden? Diese Aktion kann nicht rückgängig gemacht werden. Bitte stattdessen ausmustern, wenn der Gerätebestand erhalten bleiben soll.`)) return;
    try {
      await api(`/devices/${deviceId}`, {method: 'DELETE'});
      navigate('/devices');
    } catch (cause) {
      setError(message(cause));
    }
  }

  const canWrite = hasPermission('devices:write');
  const canDelete = hasPermission('devices:delete');
  const canDmsWrite = hasPermission('dms:write');

  if (loading) return <section className="object-management"><p role="status">Geräteakte wird geladen …</p></section>;
  if (!file) return <section className="object-management">{error && <p role="alert">{error}</p>}<button type="button" onClick={() => navigate('/devices')}>{commonText.backToOverview}</button></section>;
  const device = file.device;

  return <section className="object-management">
    <button className="object-back" type="button" onClick={() => navigate('/devices')}>← Zur Geräteübersicht</button>
    {error && <p className="object-warning" role="alert">{error}</p>}
    {success && <p role="status">{success}</p>}

    <div className="object-detail-header">
      <div>
        <div className="object-eyebrow">Digitale Geräteakte · {device.asset_number ?? 'Ohne Inventarnummer'}</div>
        <h2>{device.name}</h2>
        <p>{[device.manufacturer, device.model].filter(Boolean).join(' / ') || 'Kein Hersteller hinterlegt'}</p>
        <div className="object-header-meta">
          <span className={`object-status ${statusClass(device.operational_status)}`}>{operationalLabel(device.operational_status)}</span>
          <span>Objekt: {device.site_name ?? commonText.notAssigned}</span>
          <span>Verantwortlich: {device.responsible_employee_name ?? commonText.notAssigned}</span>
          <span>Aktualisiert: {formatDateTime(device.updated_at)}</span>
        </div>
      </div>
      <div className="object-actions">
        {canWrite && <button type="button" onClick={() => setTab('stammdaten')}>Stammdaten bearbeiten</button>}
        {canWrite && <button type="button" onClick={() => { setAssignForm({site_id: device.site_id ?? '', location_id: device.location_id ?? ''}); setAssignOpen(open => !open); setResponsibleOpen(false); }}>Objekt zuordnen</button>}
        {canWrite && <button type="button" onClick={() => { setResponsibleId(device.responsible_employee_id ?? ''); setResponsibleOpen(open => !open); setAssignOpen(false); }}>Verantwortlichen ändern</button>}
        {canWrite && <button type="button" onClick={() => setTab('wartung')}>Wartungsauftrag erstellen</button>}
        {canWrite && <button type="button" onClick={async () => {
          if (!window.confirm(`Soll „${device.name}“ ausgemustert werden? Der Gerätebestand bleibt revisionssicher erhalten.`)) return;
          await run(async () => { await api(`/devices/${deviceId}/archive`, {method: 'POST', body: JSON.stringify({reason: 'Ausmusterung aus der Geräteakte'})}); }, 'Das Gerät wurde ausgemustert.');
        }}>Ausmustern</button>}
        {canDelete && <button type="button" onClick={() => void deleteDevice()}>Endgültig löschen</button>}
      </div>
    </div>

    {canWrite && assignOpen && <form className="object-inline-form" onSubmit={assignSite}>
      <h4>Objektzuordnung ändern</h4>
      <label>Objekt
        <select value={assignForm.site_id} onChange={event => setAssignForm({site_id: event.target.value, location_id: ''})}>
          <option value="">Kein Objekt</option>
          {sites.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}
        </select>
      </label>
      <label>Standort / Bereich
        <select value={assignForm.location_id} onChange={event => setAssignForm({...assignForm, location_id: event.target.value})}>
          <option value="">Gesamtes Objekt</option>
          {locations.map(location => <option key={location.id} value={location.id}>{location.name}</option>)}
        </select>
      </label>
      <button type="submit">Zuordnung speichern</button>
      <button type="button" onClick={() => setAssignOpen(false)}>{commonText.cancel}</button>
    </form>}

    {canWrite && responsibleOpen && <form className="object-inline-form" onSubmit={changeResponsible}>
      <h4>Verantwortlichen Mitarbeiter ändern</h4>
      <label>Verantwortlicher Mitarbeiter
        <select value={responsibleId} onChange={event => setResponsibleId(event.target.value)}>
          <option value="">Nicht zugewiesen</option>
          {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
        </select>
      </label>
      <button type="submit">Verantwortlichen speichern</button>
      <button type="button" onClick={() => setResponsibleOpen(false)}>{commonText.cancel}</button>
    </form>}

    <div className="object-tabs">
      {[
        ['uebersicht', 'Übersicht'],
        ['stammdaten', 'Technische Stammdaten'],
        ['pruefung', 'Prüfungen'],
        ['wartung', 'Wartung'],
        ['ereignisse', 'Störungen & Ereignisse'],
        ['dokumente', 'Dokumente'],
        ['historie', 'Änderungshistorie'],
      ].map(([key, label]) => <button type="button" key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
    </div>

    {tab === 'uebersicht' && <div className="object-summary-grid">
      <article><h3>Inventarnummer</h3><p>{device.asset_number ?? commonText.notAvailable}</p></article>
      <article><h3>Seriennummer</h3><p>{device.serial_number ?? commonText.notAvailable}</p></article>
      <article><h3>Standort / Bereich</h3><p>{device.location_name ?? device.site_name ?? commonText.notAvailable}</p></article>
      <article><h3>Nächste Prüfung</h3><p>{formatDate(device.next_inspection_on)}</p></article>
      <article><h3>Nächste Wartung</h3><p>{formatDate(device.effective_maintenance_on ?? device.next_maintenance_on)}</p></article>
      <article><h3>Offene Wartungsaufträge</h3><p>{file.maintenance_orders.filter(order => ['planned', 'open', 'in_progress'].includes(order.status)).length}</p></article>
      <article><h3>Dokumente</h3><p>{file.documents.length}</p></article>
      <article><h3>Technischer Status</h3><p>{statusLabel(device.status ?? '', 'device')}</p></article>
      <article><h3>Wartungsintervall</h3><p>{device.maintenance_interval_days ? `${device.maintenance_interval_days} Tage` : commonText.notAvailable}</p></article>
    </div>}

    {tab === 'stammdaten' && <div className="object-detail-content">
      <h3>Technische Stammdaten</h3>
      <p className="muted">Alle Angaben werden direkt im zentralen Gerätebestand gespeichert und sind auch in der Objektverwaltung sichtbar.</p>
      <form className="object-detail-form" onSubmit={saveMasterData}>
        <div className="form-grid">
          <DeviceFormFields
            form={form}
            onChange={(field, value) => setForm(current => ({...current, [field]: value}))}
            sites={sites}
            employees={employees}
            locations={locations}
            categories={categories}
            manufacturers={manufacturers}
          />
        </div>
        {canWrite && <button type="submit">{commonText.save}</button>}
      </form>
    </div>}

    {tab === 'pruefung' && <div className="object-detail-content">
      <h3>Prüfungsmanagement</h3>
      <p className="muted">Prüfungsdaten werden unabhängig von Wartungsaufträgen dokumentiert.</p>
      <form className="object-inline-form" onSubmit={updateInspection}>
        <label>Letzte Prüfung
          <input type="date" value={inspection.last_inspection_on} onChange={event => setInspection({...inspection, last_inspection_on: event.target.value})} />
        </label>
        <label>Nächste Prüfung
          <input type="date" value={inspection.next_inspection_on} onChange={event => setInspection({...inspection, next_inspection_on: event.target.value})} />
        </label>
        {canWrite && <button type="submit">Prüfungsdaten speichern</button>}
      </form>
      <p>
        Fälligkeit:{' '}
        <span className={`object-status ${inspectionStates[device.inspection_state ?? ''] === 'Überfällig' ? 'restricted' : ''}`}>
          {inspectionStates[device.inspection_state ?? 'none'] ?? commonText.notAvailable}
        </span>
      </p>
    </div>}

    {tab === 'wartung' && <div className="object-detail-content">
      <h3>Wartungsmanagement</h3>
      {canWrite && <form className="object-inline-form" onSubmit={createMaintenance}>
        <label>Wartungsart
          <select value={maintenanceForm.maintenance_type} onChange={event => setMaintenanceForm({...maintenanceForm, maintenance_type: event.target.value})}>
            {maintenanceTypes.map(value => <option key={value} value={value}>{maintenanceTypeLabels[value]}</option>)}
          </select>
        </label>
        <label>Beschreibung *
          <input required minLength={3} value={maintenanceForm.description} onChange={event => setMaintenanceForm({...maintenanceForm, description: event.target.value})} />
        </label>
        <label>Priorität
          <select value={maintenanceForm.priority_code} onChange={event => setMaintenanceForm({...maintenanceForm, priority_code: event.target.value})}>
            {priorities.map(value => <option key={value} value={value}>{statusLabel(value, 'priority')}</option>)}
          </select>
        </label>
        <label>Fällig am
          <input type="date" value={maintenanceForm.due_on} onChange={event => setMaintenanceForm({...maintenanceForm, due_on: event.target.value})} />
        </label>
        <label>Verantwortlicher Mitarbeiter
          <select value={maintenanceForm.responsible_employee_id} onChange={event => setMaintenanceForm({...maintenanceForm, responsible_employee_id: event.target.value})}>
            <option value="">Nicht zugewiesen</option>
            {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <button type="submit">Wartungsauftrag erstellen</button>
      </form>}

      {file.maintenance_orders.length === 0 ? <p className="object-empty">Keine Wartungsaufträge erfasst.</p> : (
        <ul>
          {file.maintenance_orders.map(order => <li key={order.id}>
            <strong>{order.order_number}</strong> · {maintenanceTypeLabels[order.maintenance_type] ?? order.maintenance_type} ·{' '}
            <span className={`object-status ${order.overdue ? 'restricted' : ''}`}>{order.status_label}</span> ·{' '}
            {order.description} · Fällig: {formatDate(order.due_on)} · {order.responsible_employee_name ?? commonText.notAssigned}
            {order.performed_work && <p>Durchgeführt: {order.performed_work}</p>}
            {(order.documents ?? []).length > 0 && <p>Nachweise: {order.documents!.map(document => document.document_title).join(', ')}</p>}
            {canWrite && ['planned', 'open'].includes(order.status) && <button type="button" onClick={() => void changeOrderStatus(order.id, 'in_progress')}>In Bearbeitung setzen</button>}
            {canWrite && order.status === 'in_progress' && <button type="button" onClick={() => { setCompletionOrderId(order.id); setCompletionText(''); }}>Abschließen</button>}
            {canWrite && ['planned', 'open', 'in_progress'].includes(order.status) && <button type="button" onClick={() => { setCancellationOrderId(order.id); setCancellationReason(''); }}>Stornieren</button>}
            {canWrite && file.documents.length > 0 && <button type="button" onClick={() => { setLinkOrderId(order.id); setLinkDocumentId(file.documents[0]?.id ?? ''); }}>Nachweis verknüpfen</button>}
          </li>)}
        </ul>
      )}

      {completionOrderId && <form className="object-inline-form" onSubmit={completeOrder}>
        <h4>Wartungsauftrag abschließen</h4>
        <label>Durchgeführte Arbeit *
          <textarea required minLength={3} value={completionText} onChange={event => setCompletionText(event.target.value)} />
        </label>
        <button type="submit">Abschluss speichern</button>
        <button type="button" onClick={() => setCompletionOrderId('')}>{commonText.cancel}</button>
      </form>}
      {cancellationOrderId && <form className="object-inline-form" onSubmit={cancelOrder}>
        <h4>Wartungsauftrag stornieren</h4>
        <label>Grund *
          <input required minLength={3} value={cancellationReason} onChange={event => setCancellationReason(event.target.value)} />
        </label>
        <button type="submit">Stornierung speichern</button>
        <button type="button" onClick={() => setCancellationOrderId('')}>{commonText.cancel}</button>
      </form>}
      {linkOrderId && <form className="object-inline-form" onSubmit={linkDocument}>
        <h4>Nachweis verknüpfen</h4>
        <label>Dokument
          <select value={linkDocumentId} onChange={event => setLinkDocumentId(event.target.value)}>
            {file.documents.map(document => <option key={document.id} value={document.id}>{document.title}</option>)}
          </select>
        </label>
        <button type="submit">Verknüpfen</button>
        <button type="button" onClick={() => setLinkOrderId('')}>{commonText.cancel}</button>
      </form>}
    </div>}

    {tab === 'ereignisse' && <div className="object-detail-content">
      <h3>Störungs- und Ereignishistorie</h3>
      {file.alarms.length === 0 ? <p className="object-empty">Keine Alarme oder Störungen für dieses Gerät erfasst.</p> : (
        <ul>{file.alarms.map(alarm => <li key={alarm.id}>
          <strong>{statusLabel(alarm.severity, 'alarm')}</strong> · {alarm.message} · {formatDateTime(alarm.triggered_at)} · {statusLabel(alarm.status, 'alarm')}
        </li>)}</ul>
      )}
      {file.maintenance_orders.filter(order => ['corrective', 'repair'].includes(order.maintenance_type)).map(order => (
        <p key={order.id}><strong>{order.order_number}</strong>: {order.description} ({order.status_label})</p>
      ))}
    </div>}

    {tab === 'dokumente' && <div className="object-detail-content">
      <h3>Dokumente der Geräteakte</h3>
      {canDmsWrite && <form className="object-inline-form" onSubmit={uploadDocument}>
        <h4>Dokument hinzufügen</h4>
        <label>Titel *
          <input required value={documentForm.title} onChange={event => setDocumentForm({...documentForm, title: event.target.value})} />
        </label>
        <label>Dokumentart
          <input value={documentForm.document_type} onChange={event => setDocumentForm({...documentForm, document_type: event.target.value})} />
        </label>
        <label>Verantwortlicher
          <select value={documentForm.responsible_employee_id} onChange={event => setDocumentForm({...documentForm, responsible_employee_id: event.target.value})}>
            <option value="">Nicht zugewiesen</option>
            {employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name}</option>)}
          </select>
        </label>
        <label>Datei *
          <input type="file" required onChange={event => setDocumentFile(event.target.files?.[0] ?? null)} />
        </label>
        <button type="submit">Dokument speichern</button>
      </form>}
      {file.documents.length === 0 ? <p className="object-empty">Keine Dokumente in der Geräteakte erfasst.</p> : (
        <ul>{file.documents.map(document => <li key={document.id}>
          <strong>{document.title}</strong> · {document.document_type ?? 'Ohne Dokumentart'} ·{' '}
          {statusLabel(document.document_status, 'document')} · {formatDate(document.valid_until)}
          {' · '}<button type="button" onClick={() => void downloadDocument(document.id, document.latest_version_id ?? '')}>{commonText.download}</button>
        </li>)}</ul>
      )}
    </div>}

    {tab === 'historie' && <div className="object-activity">
      <h3>Änderungshistorie</h3>
      {file.history.length === 0 ? <p className="object-empty">Noch keine Änderungen protokolliert.</p> : (
        <ol>{file.history.map(event => <li key={event.id}>
          <time>{formatDateTime(event.created_at)}</time>
          <span>{auditEventLabel(event.event_type)}</span>
          <span>
            {Object.entries(event.details ?? {}).map(([key, value]) => <small key={key}>{historyDetailText(key, value)} </small>)}
          </span>
        </li>)}</ol>
      )}
    </div>}
  </section>;
}
