/**
 * Fleet Operations Platform — in-memory, tenant-scoped seed store.
 *
 * This module is intentionally self-contained and shares NOTHING with the
 * existing driver-feedback application or its PostgreSQL database. The spec
 * (§5.4, §25) requires non-production/staging to run on synthetic data that is
 * never mixed with production PII, so the reference build ships with a
 * deterministic synthetic dataset generated at process start.
 *
 * Every business record carries `tenant_id`. All reads/writes elsewhere in the
 * module go through helpers that scope by the caller's active tenant (§4).
 */

'use strict';

// ── deterministic pseudo-random so seeds are stable across restarts ──────────
let _seed = 20260703;
function rand() {
  _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}
let _idCounter = 1000;
function uid(prefix) {
  _idCounter += 1;
  return `${prefix}_${_idCounter.toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;
}

function isoDaysFromNow(days, hour = 9) {
  // Deterministic clock anchored to the spec's reference date (2026-07-03).
  const base = Date.UTC(2026, 6, 3, hour, 0, 0);
  return new Date(base + days * 86400000).toISOString();
}

const DEPARTMENTS = ['Fleet', 'Updater', 'Dispatcher', 'Insurance', 'Safety', 'HR', 'Accounting', 'Drivers'];

const PERMISSIONS = [
  'loads.read', 'loads.create', 'loads.update', 'loads.delete', 'loads.update_status',
  'drivers.read', 'drivers.assign', 'drivers.manage',
  'equipment.read', 'equipment.manage',
  'brokers.read', 'brokers.manage',
  'tasks.read', 'tasks.create', 'tasks.comment', 'tasks.archive',
  'email.read', 'email.download',
  'reports.read', 'reports.adjust',
  'location.read',
  'drivers.contact',
  'users.manage', 'roles.manage',
  'settings.manage', 'integrations.manage',
  'import.run', 'export.run',
  'audit.read',
];

// Role → permission mapping (§3, §16).
const ROLE_TEMPLATES = {
  Viewer: ['loads.read', 'drivers.read', 'equipment.read', 'brokers.read', 'tasks.read', 'email.read', 'reports.read'],
  Dispatcher: [
    'loads.read', 'loads.create', 'loads.update', 'loads.update_status', 'drivers.read', 'drivers.assign',
    'equipment.read', 'brokers.read', 'tasks.read', 'tasks.create', 'tasks.comment', 'email.read',
    'location.read', 'drivers.contact', 'reports.read',
  ],
  'Team Lead': [
    'loads.read', 'loads.create', 'loads.update', 'loads.update_status', 'loads.delete',
    'drivers.read', 'drivers.assign', 'drivers.manage', 'equipment.read', 'equipment.manage',
    'brokers.read', 'brokers.manage', 'tasks.read', 'tasks.create', 'tasks.comment', 'tasks.archive',
    'email.read', 'email.download', 'location.read', 'drivers.contact', 'reports.read', 'reports.adjust',
    'import.run', 'export.run',
  ],
  'Company Administrator': [...PERMISSIONS],
};

function makeTenant(name, slug) {
  const tenantId = uid('tnt');
  const companies = [];
  const companyNames = name === 'Wenzel Logistics'
    ? ['Wenzel Carrier LLC', 'Wenzel Express Inc']
    : ['Redline Freight Co'];
  companyNames.forEach((cn, i) => {
    companies.push({
      id: uid('cmp'),
      tenant_id: tenantId,
      name: cn,
      mc_number: `MC${randInt(100000, 999999)}`,
      phone_e164: `+1312${randInt(2000000, 9999999)}`,
      email: `ops@${cn.toLowerCase().replace(/[^a-z]/g, '')}.com`,
      timezone_iana: pick(['America/Chicago', 'America/New_York', 'America/Denver']),
      address_line1: `${randInt(100, 9999)} Freight Ave`,
      address_line2: '',
      city: pick(['Chicago', 'Dallas', 'Denver', 'Atlanta']),
      state: pick(['IL', 'TX', 'CO', 'GA']),
      postal_code: `${randInt(10000, 99999)}`,
      country: 'US',
      latitude: 41.8 + rand(),
      longitude: -87.6 - rand(),
      status: 'active',
      created_at: isoDaysFromNow(-400),
      updated_at: isoDaysFromNow(-10),
      created_by: 'system',
      updated_by: 'system',
    });
  });
  return { id: tenantId, name, slug, status: 'active', plan: 'pro', companies };
}

function buildRoles(tenantId) {
  return Object.entries(ROLE_TEMPLATES).map(([roleName, perms]) => ({
    id: uid('rol'),
    tenant_id: tenantId,
    name: roleName,
    description: `${roleName} role`,
    permissions: perms,
    system: roleName === 'Company Administrator',
    created_at: isoDaysFromNow(-390),
  }));
}

const FIRST_NAMES = ['James', 'Maria', 'David', 'Sofia', 'Michael', 'Elena', 'Robert', 'Aisha', 'Daniel', 'Priya', 'Ivan', 'Grace', 'Omar', 'Lucia', 'Noah', 'Fatima'];
const LAST_NAMES = ['Carter', 'Nguyen', 'Reyes', 'Kim', 'Johnson', 'Petrov', 'Silva', 'Khan', 'Miller', 'Patel', 'Lopez', 'Osei', 'Rossi', 'Adams', 'Brown', 'Diaz'];

function fullName(f, l) { return `${f} ${l}`; }

function build() {
  const tenants = [makeTenant('Wenzel Logistics', 'wenzel'), makeTenant('Redline Freight', 'redline')];
  const db = {
    tenants,
    companies: [],
    users: [],
    roles: [],
    drivers: [],
    equipment: [],
    brokers: [],
    loads: [],
    loadStops: [],
    assignments: [],
    loadStatusHistory: [],
    vehicleLocations: [],
    etaSnapshots: [],
    eldStatus: [],
    tasks: [],
    taskComments: [],
    taskLabels: [],
    taskActivity: [],
    emailAccounts: [],
    emailThreads: [],
    emailMessages: [],
    notifications: [],
    notificationRules: [],
    companySettings: [],
    integrations: [],
    fuelPrices: [],
    reportTargets: [],
    auditLog: [],
    sessions: {},
  };

  tenants.forEach((t) => {
    db.companies.push(...t.companies);
    const roles = buildRoles(t.id);
    db.roles.push(...roles);
    const roleByName = Object.fromEntries(roles.map((r) => [r.name, r]));
    const defaultCompany = t.companies[0];

    // ── Users ──
    const adminUser = {
      id: uid('usr'), tenant_id: t.id, first_name: 'Ops', last_name: 'Admin',
      display_name: `${t.slug}-admin`,
      email: `admin@${t.slug}.example.com`, phone_e164: '+13125550100',
      status: 'active', last_login_at: isoDaysFromNow(-1),
      department: 'Fleet', role_ids: [roleByName['Company Administrator'].id],
      company_ids: t.companies.map((c) => c.id), default_company_id: defaultCompany.id,
      leader_user_id: null, password: 'demo1234',
      created_at: isoDaysFromNow(-380),
    };
    db.users.push(adminUser);

    const teamLead = {
      id: uid('usr'), tenant_id: t.id, first_name: pick(FIRST_NAMES), last_name: pick(LAST_NAMES),
      display_name: '', email: `lead@${t.slug}.example.com`, phone_e164: '+13125550111',
      status: 'active', last_login_at: isoDaysFromNow(-1), department: 'Dispatcher',
      role_ids: [roleByName['Team Lead'].id], company_ids: [defaultCompany.id],
      default_company_id: defaultCompany.id, leader_user_id: null, password: 'demo1234',
      created_at: isoDaysFromNow(-370),
    };
    teamLead.display_name = fullName(teamLead.first_name, teamLead.last_name);
    db.users.push(teamLead);

    const dispatchers = [];
    for (let i = 0; i < 4; i += 1) {
      const f = pick(FIRST_NAMES); const l = pick(LAST_NAMES);
      const d = {
        id: uid('usr'), tenant_id: t.id, first_name: f, last_name: l, display_name: fullName(f, l),
        email: `disp${i}@${t.slug}.example.com`, phone_e164: `+1312555${randInt(1000, 9999)}`,
        status: 'active', last_login_at: isoDaysFromNow(-randInt(0, 5)), department: 'Dispatcher',
        role_ids: [roleByName.Dispatcher.id], company_ids: [defaultCompany.id],
        default_company_id: defaultCompany.id, leader_user_id: teamLead.id, password: 'demo1234',
        created_at: isoDaysFromNow(-randInt(100, 360)),
      };
      db.users.push(d); dispatchers.push(d);
    }
    const viewer = {
      id: uid('usr'), tenant_id: t.id, first_name: pick(FIRST_NAMES), last_name: pick(LAST_NAMES),
      display_name: '', email: `viewer@${t.slug}.example.com`, phone_e164: '+13125550122',
      status: 'active', last_login_at: isoDaysFromNow(-2), department: 'Accounting',
      role_ids: [roleByName.Viewer.id], company_ids: [defaultCompany.id],
      default_company_id: defaultCompany.id, leader_user_id: teamLead.id, password: 'demo1234',
      created_at: isoDaysFromNow(-200),
    };
    viewer.display_name = fullName(viewer.first_name, viewer.last_name);
    db.users.push(viewer);

    // ── Task labels ──
    const labels = [
      { name: 'Detention', color: '#d4380d' },
      { name: 'Paperwork', color: '#d48806' },
      { name: 'Urgent', color: '#cf1322' },
      { name: 'Follow-up', color: '#1677ff' },
    ].map((l) => ({ id: uid('lbl'), tenant_id: t.id, ...l, active: true, note: '' }));
    db.taskLabels.push(...labels);

    // ── Brokers ──
    const brokers = [];
    const brokerNames = ['TQL', 'Coyote Logistics', 'Echo Global', 'RXO', 'CH Robinson', 'Landstar'];
    brokerNames.forEach((bn) => {
      const b = {
        id: uid('brk'), tenant_id: t.id, legal_name: `${bn} LLC`, display_name: bn,
        mc_number: `MC${randInt(200000, 899999)}`,
        email: `carrier@${bn.toLowerCase().replace(/[^a-z]/g, '')}.com`,
        phone_e164: `+1${randInt(2000000000, 9999999999)}`,
        address: `${randInt(100, 999)} Broker Blvd, ${pick(['Chicago', 'Dallas', 'Atlanta'])}`,
        status: pick(['active', 'active', 'active', 'inactive']),
        canonical_broker_id: null, created_at: isoDaysFromNow(-randInt(100, 380)),
      };
      db.brokers.push(b); brokers.push(b);
    });

    // ── Equipment (trucks + trailers) ──
    const trucks = []; const trailers = [];
    for (let i = 0; i < 14; i += 1) {
      const tr = {
        id: uid('eqp'), tenant_id: t.id, type: 'truck', unit_number: `${randInt(100, 899)}`,
        vin: `1FUJGLDR${randInt(10, 99)}LS${randInt(100000, 999999)}`,
        make: pick(['Freightliner', 'Volvo', 'Kenworth', 'Peterbilt']), model: pick(['Cascadia', 'VNL', 'T680', '579']),
        year: randInt(2018, 2024), license_plate: `${pick(['IL', 'TX', 'CO'])}-${randInt(10000, 99999)}`,
        jurisdiction: pick(['IL', 'TX', 'CO']), fuel_type: 'diesel',
        registered_weight: randInt(30000, 80000), operated_by_company_id: defaultCompany.id,
        status: 'available', eld_device_id: `ELD-${randInt(1000, 9999)}`, eld_provider: pick(['Samsara', 'Motive', 'DriveHOS']),
        created_at: isoDaysFromNow(-randInt(100, 360)),
      };
      db.equipment.push(tr); trucks.push(tr);
    }
    for (let i = 0; i < 16; i += 1) {
      const tl = {
        id: uid('eqp'), tenant_id: t.id, type: 'trailer', unit_number: `T${randInt(100, 899)}`,
        vin: `1UYVS2532${randInt(10, 99)}P${randInt(100000, 999999)}`,
        make: pick(['Wabash', 'Utility', 'Great Dane']), model: pick(['DuraPlate', '3000R', 'Reefer']),
        year: randInt(2016, 2024), license_plate: `${pick(['IL', 'TX'])}-${randInt(10000, 99999)}`,
        jurisdiction: pick(['IL', 'TX']), fuel_type: 'n/a', registered_weight: randInt(10000, 15000),
        operated_by_company_id: defaultCompany.id, status: 'available', eld_device_id: null, eld_provider: null,
        created_at: isoDaysFromNow(-randInt(100, 360)),
      };
      db.equipment.push(tl); trailers.push(tl);
    }

    // ── Drivers ──
    const drivers = [];
    for (let i = 0; i < 12; i += 1) {
      const f = pick(FIRST_NAMES); const l = pick(LAST_NAMES);
      const truck = trucks[i] || pick(trucks);
      const disp = pick(dispatchers);
      const d = {
        id: uid('drv'), tenant_id: t.id, first_name: f, middle_name: '', last_name: l,
        display_name: fullName(f, l), position: pick(['company_driver', 'owner_operator', 'lease_operator']),
        phone_e164: `+1${randInt(2000000000, 9999999999)}`, email: `${f.toLowerCase()}.${l.toLowerCase()}@drivers.example.com`,
        status: pick(['active', 'active', 'active', 'inactive']), hired_company_id: defaultCompany.id,
        primary_dispatcher_id: disp.id, assigned_truck_id: truck.id, eld_driver_id: `EDR-${randInt(1000, 9999)}`,
        hire_date: isoDaysFromNow(-randInt(60, 900)), created_at: isoDaysFromNow(-randInt(60, 900)),
      };
      db.drivers.push(d); drivers.push(d);

      // ELD status per driver
      db.eldStatus.push({
        id: uid('eld'), tenant_id: t.id, driver_id: d.id, truck_id: truck.id,
        connection_state: pick(['connected', 'connected', 'connected', 'disconnected']),
        inspection_state: pick(['ok', 'ok', 'expiring']), stationary: rand() < 0.2,
        sleep_timer_minutes: rand() < 0.15 ? randInt(60, 600) : 0,
        last_provider_update_at: isoDaysFromNow(0, randInt(0, 12)), error_reason: null,
      });
    }

    // ── Company settings ──
    t.companies.forEach((c) => {
      db.companySettings.push({
        id: uid('set'), tenant_id: t.id, company_id: c.id,
        check_in_radius_miles: 0.5, eld_inspection_expiration_days: 30,
        detention_threshold_minutes: 120, auto_create_detention_task: true,
        version: 1, updated_at: isoDaysFromNow(-20), updated_by: adminUser.id,
      });
    });

    // ── Integrations ──
    [
      { type: 'tms', provider: 'DAT / McLeod', state: 'connected' },
      { type: 'eld', provider: 'Samsara', state: 'connected' },
      { type: 'email', provider: 'Microsoft 365', state: 'degraded' },
      { type: 'ringcentral', provider: 'RingCentral', state: 'disconnected' },
      { type: 'telegram', provider: 'Telegram Bot', state: 'connected' },
    ].forEach((cfg) => {
      db.integrations.push({
        id: uid('int'), tenant_id: t.id, company_id: defaultCompany.id, type: cfg.type,
        provider: cfg.provider, masked_account_label: `••••${randInt(1000, 9999)}`,
        state: cfg.state, last_health_check_at: isoDaysFromNow(0, randInt(0, 12)),
        last_successful_sync_at: cfg.state === 'connected' ? isoDaysFromNow(0, randInt(0, 12)) : isoDaysFromNow(-2),
        error_message: cfg.state === 'degraded' ? 'Token refresh delayed; polling fallback active' : (cfg.state === 'disconnected' ? 'Not connected' : null),
      });
    });

    // ── Notification rules ──
    ['ETA Update', 'Load Assignment', 'Accept', 'Resend Document', 'Paperwork Issue', 'Wake Up Call', 'Mark As Delivered', 'Stationary Driver', 'Check-in / Check-out'].forEach((evt) => {
      db.notificationRules.push({
        id: uid('nrl'), tenant_id: t.id, event_type: evt,
        destinations: pick([['in_app', 'driver_group'], ['internal_team'], ['in_app', 'internal_team']]),
        enabled: rand() < 0.75, template_id: uid('tpl'), timezone: defaultCompany.timezone_iana,
        version: 1,
      });
    });

    // ── Email account + threads ──
    const emailAccount = {
      id: uid('eac'), tenant_id: t.id, provider: 'Microsoft 365', address: `dispatch@${t.slug}.example.com`,
      connection_state: 'degraded', last_sync_at: isoDaysFromNow(0, 8), last_error: 'Delta sync throttled by provider',
    };
    db.emailAccounts.push(emailAccount);
    const emailCats = ['Rate Cons', 'Update Request', 'Critical', 'Charges', 'Claim', 'New Load Offer'];
    for (let i = 0; i < 22; i += 1) {
      const broker = pick(brokers);
      const cat = pick(emailCats);
      const thread = {
        id: uid('eth'), tenant_id: t.id, account_id: emailAccount.id, category: cat,
        subject: `${cat}: Load #${randInt(10000, 99999)} — ${broker.display_name}`,
        sender: broker.email, sender_name: broker.display_name,
        recipients: [emailAccount.address], preview: `Please confirm ${cat.toLowerCase()} details for the referenced load...`,
        received_at: isoDaysFromNow(-randInt(0, 6), randInt(0, 20)), unread: rand() < 0.4,
        critical: cat === 'Critical' || rand() < 0.1, has_attachment: rand() < 0.5,
        related_broker_id: broker.id,
      };
      db.emailThreads.push(thread);
      const msgCount = randInt(1, 3);
      for (let m = 0; m < msgCount; m += 1) {
        db.emailMessages.push({
          id: uid('emsg'), tenant_id: t.id, thread_id: thread.id,
          sender: m % 2 === 0 ? broker.email : emailAccount.address,
          sender_name: m % 2 === 0 ? broker.display_name : 'Dispatch',
          received_at: isoDaysFromNow(-randInt(0, 6), randInt(0, 20)),
          // NOTE: rendered sanitized on the client in a sandboxed iframe (§6.9).
          body_html: `<p>Hello,</p><p>Regarding <b>${thread.subject}</b>, please review the attached rate confirmation and confirm the appointment window.</p><p>Thanks,<br/>${m % 2 === 0 ? broker.display_name : 'Dispatch Team'}</p>`,
          body_text: `Regarding ${thread.subject}, please review the attached rate confirmation.`,
          attachments: thread.has_attachment && m === 0
            ? [{ id: uid('att'), filename: 'rate_confirmation.pdf', size_bytes: randInt(40000, 900000) }]
            : [],
        });
      }
    }

    // ── Loads + stops + assignments + eta/location ──
    const CITIES = [
      { c: 'Chicago, IL', lat: 41.88, lng: -87.63 }, { c: 'Dallas, TX', lat: 32.78, lng: -96.80 },
      { c: 'Atlanta, GA', lat: 33.75, lng: -84.39 }, { c: 'Denver, CO', lat: 39.74, lng: -104.99 },
      { c: 'Phoenix, AZ', lat: 33.45, lng: -112.07 }, { c: 'Memphis, TN', lat: 35.15, lng: -90.05 },
      { c: 'Columbus, OH', lat: 39.96, lng: -82.99 }, { c: 'Nashville, TN', lat: 36.16, lng: -86.78 },
      { c: 'Kansas City, MO', lat: 39.10, lng: -94.58 }, { c: 'Indianapolis, IN', lat: 39.77, lng: -86.16 },
    ];
    const STATUSES = ['upcoming', 'dispatched', 'in_transit', 'delivered', 'canceled', 'rejected'];
    for (let i = 0; i < 60; i += 1) {
      const origin = pick(CITIES); let dest = pick(CITIES);
      while (dest === origin) dest = pick(CITIES);
      const driver = pick(drivers);
      const truck = db.equipment.find((e) => e.id === driver.assigned_truck_id) || pick(trucks);
      const trailer = pick(trailers);
      const broker = pick(brokers);
      const status = pick(STATUSES.concat(['in_transit', 'in_transit', 'dispatched', 'delivered']));
      const hauling = randInt(1500, 4500) * 100; // minor units (cents)
      const assigned = Math.round(hauling * (0.6 + rand() * 0.35));
      const distance = randInt(300, 1800);
      const pickupDay = randInt(-3, 5);
      const load = {
        id: uid('lod'), tenant_id: t.id, company_id: defaultCompany.id,
        load_number: `L${25000 + i}`, trip_number: `TR${40000 + i}`, customer_ref: `REF${randInt(1000, 9999)}`,
        broker_id: broker.id, status,
        dispatcher_id: driver.primary_dispatcher_id, driver_id: driver.id,
        truck_id: truck.id, trailer_id: trailer.id,
        hauling_rate: hauling, assigned_rate: assigned, currency: 'USD',
        planned_distance_miles: distance, actual_distance_miles: status === 'delivered' ? distance + randInt(-20, 40) : null,
        pickup_window_start: isoDaysFromNow(pickupDay, 8), pickup_window_end: isoDaysFromNow(pickupDay, 12),
        delivery_window_start: isoDaysFromNow(pickupDay + 2, 8), delivery_window_end: isoDaysFromNow(pickupDay + 2, 16),
        source_timezone: defaultCompany.timezone_iana, source_system: 'TMS', external_id: `TMS-${randInt(100000, 999999)}`,
        version: 1, origin_label: origin.c, destination_label: dest.c,
        paperwork_state: pick(['all_good', 'all_good', 'document_missing', 'has_issue']),
        pinned: rand() < 0.12,
        created_at: isoDaysFromNow(pickupDay - 2), updated_at: isoDaysFromNow(0, randInt(0, 12)),
      };
      db.loads.push(load);

      db.loadStops.push(
        {
          id: uid('stp'), tenant_id: t.id, load_id: load.id, sequence: 1, type: 'pickup',
          facility_name: `${origin.c} DC`, address: `${randInt(100, 9999)} Dock St, ${origin.c}`,
          latitude: origin.lat, longitude: origin.lng, appointment_start: load.pickup_window_start,
          appointment_end: load.pickup_window_end, local_timezone: load.source_timezone,
          actual_check_in: null, actual_check_out: null, geofence_radius_miles: 0.5, status: 'planned',
        },
        {
          id: uid('stp'), tenant_id: t.id, load_id: load.id, sequence: 2, type: 'dropoff',
          facility_name: `${dest.c} Warehouse`, address: `${randInt(100, 9999)} Commerce Pkwy, ${dest.c}`,
          latitude: dest.lat, longitude: dest.lng, appointment_start: load.delivery_window_start,
          appointment_end: load.delivery_window_end, local_timezone: load.source_timezone,
          actual_check_in: null, actual_check_out: null, geofence_radius_miles: 0.5, status: 'planned',
        },
      );

      db.assignments.push({
        id: uid('asg'), tenant_id: t.id, load_id: load.id, driver_id: driver.id,
        truck_id: truck.id, trailer_id: trailer.id, dispatcher_id: load.dispatcher_id,
        effective_from: load.created_at, effective_to: null,
        state: status === 'canceled' || status === 'rejected' ? 'canceled' : (status === 'delivered' ? 'ended' : 'active'),
        reason: '', actor: adminUser.id,
      });

      db.loadStatusHistory.push({
        id: uid('lsh'), tenant_id: t.id, load_id: load.id, previous_status: null, new_status: status,
        actor: 'system', source: 'seed', timestamp: load.created_at, reason: 'Initial seed', external_event_id: null,
      });

      // Reconcile truck status with active in_transit assignment
      if (status === 'in_transit') truck.status = 'in_transit';
      else if (status === 'dispatched') truck.status = 'assigned';

      // Live location + ETA for active loads
      if (status === 'in_transit' || status === 'dispatched') {
        const frac = rand();
        const lat = origin.lat + (dest.lat - origin.lat) * frac;
        const lng = origin.lng + (dest.lng - origin.lng) * frac;
        const stale = rand() < 0.18;
        db.vehicleLocations.push({
          id: uid('vloc'), tenant_id: t.id, truck_id: truck.id, driver_id: driver.id, load_id: load.id,
          latitude: lat, longitude: lng, heading: randInt(0, 359), speed_mph: status === 'in_transit' ? randInt(0, 68) : 0,
          source_provider: truck.eld_provider, observed_at: isoDaysFromNow(0, stale ? 2 : randInt(9, 12)),
          received_at: isoDaysFromNow(0, stale ? 2 : randInt(9, 12)), accuracy_m: randInt(5, 40),
        });
        const remainingMiles = Math.round(distance * (1 - frac));
        const scheduled = new Date(load.delivery_window_end).getTime();
        const varianceMin = randInt(-240, 240);
        const eta = new Date(scheduled + varianceMin * 60000).toISOString();
        db.etaSnapshots.push({
          id: uid('eta'), tenant_id: t.id, load_id: load.id, stop_id: db.loadStops[db.loadStops.length - 1].id,
          eta_utc: eta, remaining_miles: remainingMiles, remaining_duration_minutes: Math.round(remainingMiles / 55 * 60),
          calculated_at: isoDaysFromNow(0, randInt(9, 12)), source: 'routing-provider',
          schedule_variance_minutes: varianceMin,
          timing_state: varianceMin < -20 ? 'early' : (varianceMin > 20 ? 'late' : 'on_time'),
          confidence: pick(['high', 'high', 'medium']),
        });
      }
    }

    // ── Tasks ──
    const activeLoads = db.loads.filter((l) => l.tenant_id === t.id);
    const taskSources = ['manual', 'detention', 'paperwork', 'stationary', 'email', 'bot', 'system'];
    for (let i = 0; i < 34; i += 1) {
      const load = pick(activeLoads);
      const driver = db.drivers.find((d) => d.id === load.driver_id);
      const assignee = pick(dispatchers.concat([teamLead]));
      const src = pick(taskSources);
      const status = pick(['todo', 'todo', 'in_progress', 'in_progress', 'done', 'archived']);
      const priority = pick(['high', 'medium', 'medium', 'low']);
      const task = {
        id: uid('tsk'), tenant_id: t.id,
        title: pick([
          `Missing POD for ${load.load_number}`, `Detention at delivery — ${load.load_number}`,
          `Confirm appointment ${load.load_number}`, `Driver stationary 3h — ${driver ? driver.display_name : 'unit'}`,
          `Rate discrepancy ${load.load_number}`, `Resend BOL to broker`, `Wake-up call needed`,
        ]),
        description: 'Auto-generated operational task from seed dataset.',
        status, priority, department_id: pick(DEPARTMENTS),
        creator_id: adminUser.id, assignee_id: assignee.id,
        related_load_id: load.id, related_driver_id: load.driver_id, related_broker_id: load.broker_id,
        related_company_id: defaultCompany.id,
        label_ids: src === 'detention' ? [labels[0].id] : (src === 'paperwork' ? [labels[1].id] : (rand() < 0.3 ? [pick(labels).id] : [])),
        due_at: isoDaysFromNow(randInt(-1, 4), randInt(8, 18)), source: src,
        version: 1, created_at: isoDaysFromNow(-randInt(0, 8), randInt(0, 20)),
        updated_at: isoDaysFromNow(0, randInt(0, 12)),
        has_linked_conversation: src === 'email' || src === 'bot',
      };
      db.tasks.push(task);
      db.taskComments.push({
        id: uid('cmt'), tenant_id: t.id, task_id: task.id, body: 'Reviewing with dispatch.',
        author_id: assignee.id, mentions: [], created_at: task.created_at,
      });
      db.taskActivity.push({
        id: uid('act'), tenant_id: t.id, task_id: task.id, type: 'created',
        actor: adminUser.id, timestamp: task.created_at, detail: `Created from ${src}`,
      });
    }

    // ── Notifications ──
    for (let i = 0; i < 8; i += 1) {
      db.notifications.push({
        id: uid('ntf'), tenant_id: t.id, user_id: adminUser.id,
        type: pick(['New load', 'Paperwork issue', 'Detention', 'Stationary alert', 'SLA warning', 'New email']),
        message: pick(['New load L25012 created', 'Paperwork missing on L25004', 'Detention detected at delivery', 'Driver stationary over threshold']),
        read: rand() < 0.4, created_at: isoDaysFromNow(0, randInt(0, 12)),
      });
    }

    // ── Fuel prices ──
    const fuelStates = [['IL', 'Chicago'], ['TX', 'Dallas'], ['CO', 'Denver'], ['GA', 'Atlanta'], ['TN', 'Memphis'], ['OH', 'Columbus']];
    fuelStates.forEach(([st, city]) => {
      const retail = 380 + randInt(0, 90); // cents/gal
      const discounted = retail - randInt(10, 45);
      db.fuelPrices.push({
        id: uid('fue'), tenant_id: t.id, state: st, city, retail_price: retail, discounted_price: discounted,
        saving_per_gallon: retail - discounted, effective_date: isoDaysFromNow(-randInt(0, 3)),
        source: 'Fuel network import', imported_at: isoDaysFromNow(-1, 6),
      });
    });

    // ── Report targets ──
    db.reportTargets.push({
      id: uid('tgt'), tenant_id: t.id, solo_gross: 1000000, team_gross: 1500000, rpm: 240,
      effective_date: isoDaysFromNow(-30), updated_by: adminUser.id,
    });
  });

  return db;
}

// In real mode the synthetic dataset is NEVER built — every collection is empty
// so no demo record can ever leak through a not-yet-wired endpoint. Real data
// is served exclusively by realProvider; unwired reads return honest-empty.
function emptyDb() {
  return {
    tenants: [], companies: [], users: [], roles: [], drivers: [], equipment: [],
    brokers: [], loads: [], loadStops: [], assignments: [], loadStatusHistory: [],
    vehicleLocations: [], etaSnapshots: [], eldStatus: [], tasks: [], taskComments: [],
    taskLabels: [], taskActivity: [], emailAccounts: [], emailThreads: [], emailMessages: [],
    notifications: [], notificationRules: [], companySettings: [], integrations: [],
    fuelPrices: [], reportTargets: [], auditLog: [], sessions: {},
  };
}

const { isDemo } = require('./config');
const DB = isDemo() ? build() : emptyDb();

module.exports = { DB, PERMISSIONS, DEPARTMENTS, ROLE_TEMPLATES, uid, isoDaysFromNow };
