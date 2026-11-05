/* ============================================================================
   Venue dashboard - Worker shell (ships in the FC Member Dashboard Kit)

   You are the AI running this build. This file is YOURS to finish; the owner
   never sees it. The shell already does the hard plumbing:

     - serves the dashboard page
     - a metrics API with a fixed contract the page already understands
     - an OAuth2 begin/callback flow with token storage
     - automatic access-token refresh, INCLUDING rotating refresh tokens
       (Xero rotates the refresh token on every refresh - the store persists
       the new one every time; never cache tokens outside the store)
     - plain-English connection status for the Connections screen
     - the no-API rungs built in: POST /api/ingest (file/export data in),
       an email() handler stub for emailed reports, a scheduled() cron hook,
       and a KV day-store the export-fed adapters read from

   What you fill in: the three ADAPTERS (accounting / pos / rostering), each
   marked with  >>> ADAPTER ...  blocks. Wire them against the provider's
   CURRENT documentation, per capability-matrix.md and playbook.md.

   Rules that bind every adapter (kpi-spec.md is the law):
     - accounting supplies EVERY money figure, always ex GST/sales tax
     - pos supplies ONE number: completed transaction count (no voids/refunds)
     - rostering supplies rostered cost only (projected wage %)
     - read-only scopes/permissions everywhere
     - secrets ONLY via Worker secrets (wrangler secret put NAME) - never in
       this file, never in the repo, never echoed to the owner

   Bindings expected (wrangler.toml): TOKENS (KV). Secrets: see each adapter.
============================================================================ */

import dashboardHtml from './dashboard.html';

/* ----------------------------------------------------------------------------
   Provider adapters - THE PART YOU BUILD.
   Flip `configured: true` per source as you wire it. Until then the
   dashboard honestly shows "not configured" (never a fake zero).
---------------------------------------------------------------------------- */
/* OPTIONAL no-API hooks any adapter may add (the fallback-ladder rungs):
     mode: 'export'           - source is fed by exports, not a live API
     parseExport(env, h, raw) - raw = { text, contentType }: parse the tool's
                                exported CSV/report into day rows:
                                  pos:        [{ date:'YYYY-MM-DD', count }]
                                  accounting: [{ date, revenue, cogs, wagesSuper, overheads }]
                                  rostering:  [{ date, cost }]
                                Adding parseExport makes the dashboard's
                                Connections screen offer a file-upload panel
                                for this source (the guided-upload rung).
     scheduledPull(env, h)    - cron hook (uncomment [triggers] in
                                wrangler.toml): fetch the tool's own export
                                (its report scheduler's output, a saved export
                                URL) and h.saveIngestedRows(rows).
   In export mode, implement fetchRange/fetchMonthly via h.readIngested /
   h.monthlyIngested instead of provider calls. Emailed reports: complete the
   email() handler at the bottom (needs the owner's domain on their Cloudflare
   with Email Routing pointed at this Worker). Ingest auth: the INGEST_TOKEN
   secret; if the owner uploads by hand, that same value is their upload code. */
const ADAPTERS = {

  /* >>> ADAPTER 1: ACCOUNTING (connect this FIRST - it feeds most of the board)
     Contract:
       auth: 'oauth' with the oauth{} block filled, or 'token' for a pasted key
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { revenue, cogs, wagesSuper, overheads }
                                 (numbers, ex GST/sales tax, for q.from..q.to
                                  inclusive, dates in the venue's books)
       fetchMonthly(env, h, q)-> { months:['YYYY-MM',...], revenue:[...],
                                   cogs:[...], wagesSuper:[...], overheads:[...] }
                                 (align arrays to months; null where no data)
     Map the owner's P&L faithfully: Revenue/Income section (trading income
     only - Other Income excluded), Cost of Sales section, wage + super
     accounts, Operating Expenses less wages/super. Do not re-categorise
     their books. See kpi-spec.md.
     Example (Xero): oauth with tokenAuth:'basic' (the token endpoint wants
     HTTP Basic client auth), scopes 'offline_access
     accounting.reports.profitandloss.read', P&L report endpoint, org name
     from the connections endpoint, sandbox = tenant name contains
     'Demo Company'. Secrets: ACCOUNTING_CLIENT_ID, ACCOUNTING_CLIENT_SECRET.
  */
  accounting: {
    /* Xero - live P&L, read-only (wired Oct 2026 against the kit's June 2026
       verified specifics). Scopes: offline_access + P&L report read only. */
    configured: true,
    auth: 'oauth',
    oauth: {
      authorizeUrl: 'https://login.xero.com/identity/connect/authorize',
      tokenUrl: 'https://identity.xero.com/connect/token',
      scopes: 'offline_access accounting.reports.profitandloss.read',
      clientIdSecret: 'ACCOUNTING_CLIENT_ID',
      clientSecretSecret: 'ACCOUNTING_CLIENT_SECRET',
      tokenAuth: 'basic'
    },
    async status(env, h) {
      const t = await h.getTokens();
      if (!t || !t.access_token) return { connected: false };
      const tenant = await xeroTenant(env, h);
      return { connected: true, org: tenant.name, sandbox: /demo company/i.test(tenant.name || '') };
    },
    async fetchRange(env, h, q) {
      const rep = await xeroPL(env, h, { fromDate: q.from, toDate: q.to });
      const cols = xeroParse(env, rep);
      return cols[0] ? cols[0].totals : { revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 };
    },
    async fetchMonthly(env, h, q) {
      /* Xero caps comparison periods at 12 columns per call: chunk, newest first. */
      const months = monthList(q.fromMonth, q.toMonth);
      const out = { months, revenue: [], cogs: [], wagesSuper: [], overheads: [] };
      const byMonth = {};
      for (let end = months.length - 1; end >= 0; end -= 12) {
        const start = Math.max(0, end - 11);
        const last = months[end];
        const cnt = end - start + 1;
        const params = { fromDate: last + '-01', toDate: monthEnd(last), timeframe: 'MONTH' };
        if (cnt > 1) params.periods = String(cnt - 1);
        const rep = await xeroPL(env, h, params);
        const cols = xeroParse(env, rep);
        /* columns run newest -> oldest */
        const want = months.slice(start, end + 1);
        cols.forEach(function (c, i) {
          const lm = xeroLabelMonth(c.label);
          const m = (lm && want.indexOf(lm) >= 0) ? lm : (i < cnt ? months[end - i] : null);
          if (m) byMonth[m] = c.totals;
        });
      }
      months.forEach(function (m) {
        const t = byMonth[m];
        out.revenue.push(t ? t.revenue : null); out.cogs.push(t ? t.cogs : null);
        out.wagesSuper.push(t ? t.wagesSuper : null); out.overheads.push(t ? t.overheads : null);
      });
      return out;
    }
  },

  /* >>> ADAPTER 2: POS
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { count }   (completed transactions only;
                                  exclude voided/cancelled; refunds never
                                  reduce the count; q.rollover shifts the
                                  trading-day boundary by that many hours)
       fetchMonthly(env, h, q)-> { months:[...], count:[...] }
     NEVER return a dollar figure from the POS.
     Example (Square): pasted production personal access token (secret
     POS_API_TOKEN); sandbox sign = token only answers on
     connect.squareupsandbox.com.
  */
  pos: {
    /* Lightspeed Restaurant (K-Series). Live API is partner-gated (access
       requested 15 Oct 2026), so this runs on the guided-upload rung: the owner
       exports Back Office > Reports > Sales summary (daily) and uploads
       sales_summary.csv. One number only: Guest checks per trading day = the
       "Total transactions" Lightspeed shows. No dollar figure is ever read. */
    configured: true,
    mode: 'export',
    auth: null,
    oauth: {},
    async status(env, h) {
      const last = await lastSync(env, 'pos');
      return { connected: !!last, org: last ? 'Lightspeed (uploaded sales reports)' : null, sandbox: false };
    },
    /* Storage: one KV doc per month (posm:YYYY-MM -> {"DD": count}) so a
       financial-year view is ~13 reads, not ~365 (speed + KV per-request limits). */
    async fetchRange(env, h, q) {
      const docs = await posMonthDocs(env, monthList(q.from.slice(0, 7), q.to.slice(0, 7)));
      let total = 0, days = 0;
      docs.forEach(function (d) {
        if (!d.doc) return;
        Object.keys(d.doc).forEach(function (dd) {
          const date = d.month + '-' + dd;
          if (date >= q.from && date <= q.to) { total += d.doc[dd]; days++; }
        });
      });
      return days ? { count: total } : null;
    },
    async fetchMonthly(env, h, q) {
      const months = monthList(q.fromMonth, q.toMonth);
      const docs = await posMonthDocs(env, months);
      return { months, count: docs.map(function (d) {
        if (!d.doc) return null;
        return Object.keys(d.doc).reduce(function (t, k) { return t + d.doc[k]; }, 0);
      }) };
    },
    async parseExport(env, h, raw) { return parseLightspeedK(raw.text); },
    async saveExport(env, rows) {
      const byMonth = {};
      (rows || []).forEach(function (r) {
        if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || typeof r.count !== 'number') return;
        (byMonth[r.date.slice(0, 7)] = byMonth[r.date.slice(0, 7)] || {})[r.date.slice(8)] = r.count;
      });
      let days = 0;
      await Promise.all(Object.keys(byMonth).map(async function (m) {
        const key = 'posm:' + m;
        let cur = {};
        try { cur = JSON.parse((await env.TOKENS.get(key)) || '{}'); } catch (e) { cur = {}; }
        Object.assign(cur, byMonth[m]);
        days += Object.keys(byMonth[m]).length;
        await env.TOKENS.put(key, JSON.stringify(cur));
      }));
      return days;
    }
  },

  /* >>> ADAPTER 3: ROSTERING (optional - only if the owner has one)
     Contract:
       status(env, h)        -> { connected, org, sandbox, lastSync }
       fetchRange(env, h, q) -> { cost }    (rostered labour cost for the
                                  period; powers the PROJECTED wage % only)
     If this source is gated or absent, leave configured:false - the actual
     Wage % from accounting already covers the board (fallback ladder).
     Example (Deputy): pasted permanent token (secret ROSTERING_API_TOKEN).
  */
  rostering: {
    /* Tanda (AU). Personal access token (secret ROSTERING_API_TOKEN), created by
       the owner with scopes: me roster cost. Read-only. Rostered cost =
       sum of schedule.cost from GET /api/v2/schedules?show_costs=true, pulled in
       7-day windows (the API's max range). Powers PROJECTED Wage % only. */
    configured: true,
    auth: 'token',
    oauth: {},
    async status(env, h) {
      if (!env.ROSTERING_API_TOKEN) return { connected: false };
      const me = await tandaGet(env, '/users/me');
      return { connected: true, org: (me && (me.organisation || me.organisation_name)) || null, sandbox: false };
    },
    async fetchRange(env, h, q) {
      if (!env.ROSTERING_API_TOKEN) return null;
      const windows = tandaWindows(q.from, q.to);
      if (windows.length > 10) return null; /* projection is for weeks/months; skip year-long ranges */
      const parts = await Promise.all(windows.map(function (w) {
        return tandaGet(env, '/schedules?from=' + w[0] + '&to=' + w[1] + '&show_costs=true');
      }));
      let cost = 0;
      parts.forEach(function (list) {
        (Array.isArray(list) ? list : []).forEach(function (s) {
          const c = parseFloat(s && s.cost);
          if (isFinite(c)) cost += c;
        });
      });
      return { cost: Math.round(cost * 100) / 100 };
    },
    async fetchMonthly(env, h, q) { return { months: [], cost: [] }; }
  }

};

/* ============================================================================
   Everything below is the shell. You should rarely need to edit it.
============================================================================ */

class NotConfigured extends Error {
  constructor(source) { super('not configured: ' + source); this.source = source; }
}

const PLAIN_ERRORS = {
  401: 'This connection needs reconnecting. Click Reconnect and log in again.',
  403: 'This connection is missing a permission it needs. Your AI will sort out the access.',
  429: 'The tool is asking us to slow down. Wait a few minutes, then refresh.',
  500: 'The tool had a problem at its end. Try refresh in a little while.'
};
function plainError(status) {
  return PLAIN_ERRORS[status] || ('Something went wrong talking to this tool (code ' + status + '). Try refresh; if it persists, tell your AI.');
}

/* ---------------- Token store (KV) with refresh built in ---------------- */

async function getTokens(env, source) {
  const raw = await env.TOKENS.get('tokens:' + source);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(env, source, tokens) {
  await env.TOKENS.put('tokens:' + source, JSON.stringify(tokens));
}
async function clearTokens(env, source) {
  await env.TOKENS.delete('tokens:' + source);
}
async function noteSync(env, source) {
  await env.TOKENS.put('lastSync:' + source, new Date().toISOString());
}
async function lastSync(env, source) {
  return await env.TOKENS.get('lastSync:' + source);
}

/* Build the POST to an OAuth token endpoint, honouring the adapter's client-auth
   method. tokenAuth:'basic' -> client id+secret in an HTTP Basic Authorization
   header, NOT in the body (Xero and most OpenID providers expect this); 'post'
   (or unset, for back-compat) -> client_id/client_secret in the form body. */
function tokenRequestInit(cfg, params, env) {
  const id = env[cfg.clientIdSecret] || '';
  const secret = env[cfg.clientSecretSecret] || '';
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const body = new URLSearchParams(params);
  if ((cfg.tokenAuth || 'post') === 'basic') {
    headers['Authorization'] = 'Basic ' + btoa(id + ':' + secret);
  } else {
    body.set('client_id', id);
    body.set('client_secret', secret);
  }
  return { method: 'POST', headers: headers, body: body.toString() };
}

/* Returns a valid access token for an OAuth source, refreshing (and
   persisting the ROTATED refresh token) when needed. */
async function getValidAccessToken(env, source) {
  const adapter = ADAPTERS[source];
  const tokens = await getTokens(env, source);
  if (!tokens || !tokens.access_token) { const e = new Error('no tokens'); e.status = 401; throw e; }
  const skewMs = 60 * 1000;
  if (!tokens.expires_at || Date.now() < tokens.expires_at - skewMs) return tokens.access_token;

  /* refresh */
  const cfg = adapter.oauth || {};
  if (!tokens.refresh_token || !cfg.tokenUrl) { const e = new Error('cannot refresh'); e.status = 401; throw e; }
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  }, env));
  if (!res.ok) {
    /* Another request may have just rotated the refresh token (Xero refresh
       tokens are single-use). If the store now holds a newer valid token, use it. */
    const again = await getTokens(env, source);
    if (again && again.access_token && again.access_token !== tokens.access_token &&
        again.expires_at && Date.now() < again.expires_at - skewMs) return again.access_token;
    /* refresh failed: force a reconnect rather than silently serving stale data */
    const e = new Error('refresh failed'); e.status = 401; throw e;
  }
  const fresh = await res.json();
  const updated = {
    ...tokens,
    access_token: fresh.access_token,
    /* CRITICAL: many providers (Xero!) rotate the refresh token - always keep the new one */
    refresh_token: fresh.refresh_token || tokens.refresh_token,
    obtained_refresh_at: Date.now(),
    expires_at: Date.now() + ((fresh.expires_in || 1800) * 1000)
  };
  await saveTokens(env, source, updated);
  return updated.access_token;
}

/* Helpers handed to every adapter call */
function makeHelpers(env, source) {
  return {
    getValidAccessToken: () => getValidAccessToken(env, source),
    getTokens: () => getTokens(env, source),
    saveTokens: (t) => saveTokens(env, source, t),
    noteSync: () => noteSync(env, source),
    saveIngestedRows: (rows) => saveIngestedRows(env, source, rows),
    readIngested: (from, to) => readIngested(env, source, from, to),
    monthlyIngested: (fromMonth, toMonth) => monthlyIngested(env, source, fromMonth, toMonth),
    /* fetch JSON with one automatic refresh-and-retry on 401 (OAuth sources) */
    fetchJson: async (url, init, opts) => {
      const useAuth = !opts || opts.auth !== false;
      const doFetch = async () => {
        const headers = new Headers((init && init.headers) || {});
        if (useAuth && ADAPTERS[source].auth === 'oauth') {
          headers.set('Authorization', 'Bearer ' + await getValidAccessToken(env, source));
        }
        return fetch(url, { ...(init || {}), headers });
      };
      let res = await doFetch();
      if (res.status === 401 && useAuth && ADAPTERS[source].auth === 'oauth') {
        const t = await getTokens(env, source);
        if (t && t.expires_at && Date.now() > (t.obtained_refresh_at || 0) + 120000) { t.expires_at = 0; await saveTokens(env, source, t); } /* force refresh */
        res = await doFetch();
      }
      if (!res.ok) { const e = new Error('HTTP ' + res.status); e.status = res.status; throw e; }
      return res.json();
    }
  };
}

/* ---------------- Xero helpers (accounting adapter) ---------------------- */
const WAGE_RE = /\b(wages?|salar(y|ies)|superannuation|super|payroll|annual leave|long service|workcover|workers'? comp(ensation)?)\b/i;

function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return d.toISOString().slice(0, 10);
}
function money(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/,/g, ''));
  return isFinite(n) ? n : 0;
}
function cents(n) { return Math.round(n * 100) / 100; }
const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
function xeroLabelMonth(label) {
  /* Column headers like "Oct-26", "Oct 2026" or "31 Oct 26" -> 'YYYY-MM' */
  const m = /([A-Za-z]{3})[A-Za-z]*[\s-]+(\d{2,4})\s*$/.exec(String(label || '').trim());
  if (!m || !MON[m[1].toLowerCase()]) return null;
  let y = parseInt(m[2], 10); if (y < 100) y += 2000;
  return y + '-' + String(MON[m[1].toLowerCase()]).padStart(2, '0');
}

async function xeroTenant(env, h) {
  const t = await h.getTokens();
  if (t && t.tenantId) return { id: t.tenantId, name: t.tenantName || null };
  const conns = await h.fetchJson('https://api.xero.com/connections', { headers: { Accept: 'application/json' } });
  if (!Array.isArray(conns) || !conns.length) { const e = new Error('no organisation'); e.status = 401; throw e; }
  const orgs = conns.filter(function (c) { return !c.tenantType || c.tenantType === 'ORGANISATION'; });
  orgs.sort(function (a, b) { return String(b.updatedDateUtc || b.createdDateUtc || '').localeCompare(String(a.updatedDateUtc || a.createdDateUtc || '')); });
  const pick = orgs[0] || conns[0];
  const fresh = await h.getTokens();
  await h.saveTokens({ ...fresh, tenantId: pick.tenantId, tenantName: pick.tenantName });
  return { id: pick.tenantId, name: pick.tenantName };
}

async function xeroPL(env, h, params) {
  const tenant = await xeroTenant(env, h);
  const p = new URLSearchParams({ standardLayout: 'true', ...params });
  if (env.ACCOUNTING_CASH_BASIS === 'true') p.set('paymentsOnly', 'true');
  const j = await h.fetchJson('https://api.xero.com/api.xro/2.0/Reports/ProfitAndLoss?' + p.toString(), {
    headers: { 'Xero-Tenant-Id': tenant.id, Accept: 'application/json' }
  });
  return (j && j.Reports && j.Reports[0]) || { Rows: [] };
}

function xeroWageList(env) {
  /* Optional owner-confirmed exact list (comma separated) overrides the keyword match. */
  const raw = env.WAGE_ACCOUNTS || '';
  const list = raw.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  return list.length ? list : null;
}

/* Walk the P&L: returns one entry per amount column with totals + line detail. */
function xeroParse(env, rep) {
  const rows = rep.Rows || [];
  const header = rows.find(function (r) { return r.RowType === 'Header'; });
  const ncols = header ? Math.max(1, (header.Cells || []).length - 1) : 1;
  const exact = xeroWageList(env);
  const cols = [];
  for (let i = 0; i < ncols; i++) {
    cols.push({ label: header && header.Cells[i + 1] ? header.Cells[i + 1].Value : null,
      totals: { revenue: 0, cogs: 0, wagesSuper: 0, overheads: 0 },
      lines: { revenue: [], cogs: [], wages: [], overheads: [], excluded: [] } });
  }
  rows.filter(function (r) { return r.RowType === 'Section'; }).forEach(function (sec) {
    const title = String(sec.Title || '').replace(/^(less|plus)\s+/i, '').trim().toLowerCase();
    let kind = null;
    if (/other income/.test(title)) kind = 'excluded';
    else if (/cost of (sales|goods)|direct costs/.test(title)) kind = 'cogs';
    else if (/^(income|revenue|trading income|sales)$/.test(title)) kind = 'revenue';
    else if (/expenses|overheads/.test(title)) kind = 'opex';
    else if (title) kind = 'excluded';
    (sec.Rows || []).forEach(function (r) {
      if (r.RowType !== 'Row' || !kind) return;
      const name = (r.Cells && r.Cells[0] && r.Cells[0].Value) || '';
      for (let i = 0; i < ncols; i++) {
        const v = money(r.Cells && r.Cells[i + 1] && r.Cells[i + 1].Value);
        const c = cols[i];
        if (kind === 'revenue') { c.totals.revenue += v; c.lines.revenue.push([name, v]); }
        else if (kind === 'cogs') { c.totals.cogs += v; c.lines.cogs.push([name, v]); }
        else if (kind === 'opex') {
          const isWage = exact ? exact.indexOf(name.trim().toLowerCase()) >= 0 : WAGE_RE.test(name);
          if (isWage) { c.totals.wagesSuper += v; c.lines.wages.push([name, v]); }
          else { c.totals.overheads += v; c.lines.overheads.push([name, v]); }
        } else { c.lines.excluded.push([(sec.Title || '') + ': ' + name, v]); }
      }
    });
  });
  cols.forEach(function (c) { Object.keys(c.totals).forEach(function (k) { c.totals[k] = cents(c.totals[k]); }); });
  return cols;
}

/* Logged-in only: line-by-line view of what was counted where, for reconciliation. */
async function apiAccountingBreakdown(env, url) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) return json({ error: 'from/to required as YYYY-MM-DD' }, 400);
  try {
    const h = makeHelpers(env, 'accounting');
    const tenant = await xeroTenant(env, h);
    const cols = xeroParse(env, await xeroPL(env, h, { fromDate: from, toDate: to }));
    return json({ org: tenant.name, from, to, basis: env.ACCOUNTING_CASH_BASIS === 'true' ? 'cash' : 'accrual',
      wageMatch: xeroWageList(env) ? 'owner-confirmed list' : 'keyword', totals: cols[0] && cols[0].totals, lines: cols[0] && cols[0].lines });
  } catch (e) { return json({ error: plainError(e.status || 500) }, 502); }
}

/* ---------------- Lightspeed K-Series export parser (pos adapter) -------- */
function csvRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  text = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; if (row.some(function (x) { return x !== ''; })) rows.push(row); row = [];
    } else cur += c;
  }
  row.push(cur); if (row.some(function (x) { return x !== ''; })) rows.push(row);
  return rows;
}
async function posMonthDocs(env, months) {
  return Promise.all(months.map(async function (m) {
    let doc = null;
    try { const raw = await env.TOKENS.get('posm:' + m); doc = raw ? JSON.parse(raw) : null; } catch (e) { doc = null; }
    return { month: m, doc };
  }));
}
function parseLightspeedK(text) {
  const rows = csvRows(text);
  if (rows.length < 2) return [];
  const head = rows[0].map(function (s) { return s.trim().toLowerCase(); });
  const di = head.findIndex(function (s) { return s === 'interval from' || s === 'date' || s === 'business day'; });
  const ci = head.findIndex(function (s) { return s === 'guest checks' || s === 'total transactions' || s === 'transactions'; });
  const ti = head.findIndex(function (s) { return s === 'interval to'; });
  if (di < 0 || ci < 0) return [];
  /* Lightspeed groups long date ranges into weeks/months. A weekly total
     can't be split into days, so refuse it rather than misdate it. */
  if (ti >= 0) {
    rows.slice(1).forEach(function (r) {
      const a = Date.parse(String(r[di] || '').trim()), b = Date.parse(String(r[ti] || '').trim());
      if (isFinite(a) && isFinite(b) && b - a > 26 * 3600 * 1000) {
        const e = new Error('grouped');
        e.plain = 'This report is grouped by week or month, not by day, so it can\u2019t be used. Export a shorter range (one month at a time) so Lightspeed shows one row per day, then upload that.';
        throw e;
      }
    });
  }
  const byDate = {};
  rows.slice(1).forEach(function (r) {
    const d = String(r[di] || '').trim().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const n = parseInt(String(r[ci] || '').replace(/[^0-9-]/g, ''), 10);
    if (!isFinite(n)) return;
    byDate[d] = (byDate[d] || 0) + n;
  });
  return Object.keys(byDate).sort().map(function (d) { return { date: d, count: byDate[d] }; });
}

/* ---------------- Tanda helpers (rostering adapter) ---------------------- */
async function tandaGet(env, path) {
  const res = await fetch('https://my.tanda.co/api/v2' + path, {
    headers: { Authorization: 'bearer ' + env.ROSTERING_API_TOKEN, Accept: 'application/json' }
  });
  if (!res.ok) { const e = new Error('Tanda HTTP ' + res.status); e.status = res.status; throw e; }
  return res.json();
}
function tandaWindows(from, to) {
  const out = [];
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    const w = new Date(d.getTime() + 6 * 86400000);
    const stop = w < end ? w : end;
    out.push([d.toISOString().slice(0, 10), stop.toISOString().slice(0, 10)]);
    d = new Date(stop.getTime() + 86400000);
  }
  return out;
}

/* ---------------- Settings sync across devices -------------------------- */
/* The page keeps settings, "Check your numbers" ticks and organisation
   confirmations in the browser. Without this, a new phone or laptop would
   start from blank (and show the unverified banner again). The Worker injects
   a tiny script that loads the saved copy from KV and saves every change back,
   so dashboard.html itself is untouched. */
const UI_KEYS = ['vd_settings', 'vd_recon', 'vd_orgok'];
const UI_SEED = {
  vd_settings: JSON.stringify({
    venueName: 'The Avoca', defaultPeriod: 'thisMonth', weekStart: 1, rolloverHour: 0,
    timezone: 'Australia/Sydney', accent: 'gold', dataMode: 'live',
    targets: { wage: 30, cogs: 30, acs: 30 }
  })
};
async function getUiState(env) {
  try { return JSON.parse((await env.TOKENS.get('uistate')) || '{}'); } catch (e) { return {}; }
}
async function dashboardPage(env) {
  const st = await getUiState(env);
  for (const k in UI_SEED) if (!(k in st)) st[k] = UI_SEED[k];
  const payload = JSON.stringify(st).replace(/</g, '\\u003c');
  const script = '<script>(function(){var st=' + payload + ',keys=' + JSON.stringify(UI_KEYS) + ';' +
    'function push(k,v){try{fetch("/api/uistate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({k:k,v:v}),keepalive:true});}catch(e){}}' +
    'try{keys.forEach(function(k){if(k in st){localStorage.setItem(k,st[k]);}else{var l=localStorage.getItem(k);if(l)push(k,l);}});}catch(e){}' +
    'var o=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){o.call(this,k,v);try{if(this===window.localStorage&&keys.indexOf(k)>=0)push(k,v);}catch(e){}};' +
    '})();</script>';
  const i = dashboardHtml.indexOf('<head>');
  return i >= 0 ? dashboardHtml.slice(0, i + 6) + script + dashboardHtml.slice(i + 6) : script + dashboardHtml;
}
async function apiUiState(env, request) {
  let body = null;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad body' }, 400); }
  if (!body || UI_KEYS.indexOf(body.k) < 0 || typeof body.v !== 'string' || body.v.length > 50000) return json({ error: 'bad key' }, 400);
  const st = await getUiState(env);
  st[body.k] = body.v;
  await env.TOKENS.put('uistate', JSON.stringify(st));
  return json({ ok: true });
}

/* ---------------- Home-screen app (manifest + icons) --------------------- */
/* Lets the owner add the dashboard to a phone home screen with its own icon,
   opening full-screen. Icons are embedded so no extra files are needed. */
const APP_ICONS = {
  '/icon-192.png': 'iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAIAAADdvvtQAAAPoElEQVR42u2da2xcZXrH/8/7ntvM2DgJkDgEAoRsEsIlKQkJudhetgWVRSmQwi7B+VB1P7WqqqpVValfVuq3VqqqVq2qaqsKqQXCbhZogd1ltUVbkpAQbt1yX+7lThLixJ6ZM+e9PP1w7Nixx5mxsZbOmeen880ee86Z3zzned/zvM9Lvb29EIT5ouQSCCKQIAIJIpAgAgmCCCSIQIIIJIhAgiACCSKQIAIJIpAgiECCCCSIQIIIJAgikCACCSKQIAIJIpAgiECCCCSIQIIIJAgikCACCSKQIAIJgggkiECCCCSIQIIgAgkikCACCSKQIAIJgggkiECCCCSIQIIgAgm/IgK5BFMhAhHAs/6CZ7lIItDs9liH1BA1+ykDgeIkAotDIlBTe9IMay7yf/07DT/DEefRW8a+p8J/+ml0XpmdlwsmAp2NJmQZDQ+am7dbOwqtpt+5dIz+Pr/vYGgcFEHCkAg0JfwAmcWFi3j3DbZ+EqnBzNuYq2L1cr55o33wYLioR4KQjMKmXgWFakq/eZ352grfsAg0tGpygDA8ZLSWNEgEmpYgM8IAwwOGZ48rWqFWx9evshsvd7UGFMllE4HyS0CoNrDpCjuw3lXT6dnPVIxHbwV37zTGkAgkAk0KZA3tGTDlEqxvkWinKe7YapYt8Q0LEodEICKkBisu9LdvsWkKTa1/+YrlfOsmW0slCIlAgCbUU9q12a5cxnXTVlBxHsODJgplVloEAhwjifmeAeNsW9dCK1Tr2L7ObVljqykpJQJ1+ei9TtvWuS1rXDVFmzY4RhJjuG3nRKAin7zzGB4wcQjX9v1IE+p17NpsVy7zqen2VLp7BSJCPcOqfn/rJltrlT43y7v59i2mnpIWgbo2fU4bdMcNpv98bkwEkjanmBXBGuwZsOUSWy8CdSXWo6fMd+8wxkxmP1HYdvLUwKYr3MCVrpqSViJQt4UfhbGUhq6yG1f5Wjr+XEIR7n0yzGxbjyl8/vRjKOvywXwXf3cYe4dMoMEAM+IQH5xQf/5vyesfqSRqPcejCdU6bvk1t+YiX8+6N5XuRoEUoZZh3cXu5g2uWodScIwowsPPBCdPqYePRDqAb5XZECFzuGAR37nNNBrdm0p3qUBZg+7abpb0ceZAQKgxMop9B8Mg4oeeCT4+TknYOqFWhCzDt3aYvh42TgTqktE7YBwWn8d3bbdZBkVwHpUEP/uf4OX3dV+F3/1UPf58UCq1nhlShHoD11zqf/1a27WpdNeddF479hsb7PqVPi/rIcAz7vuvMA85WuGBA2EjayuVZoAIeweN5EBdkzozlMLeQUMTg6lyjJfeU0++HFRKbCwqJT78hj76S92TtM6E8kdj37jWXnNpl1aZdZdAilBrYMNl7sarbbUOreAZYYQHD4WnxyhU4IkJxn0HQx2gnTlC49DXg2/vMFlGIlDxBTKGvr3T9FZgHBiIAhw7iR8eCeKY86THMUoJP/pc8OHnbaXSWqHRwG9vMxcs4syCRKDCps+EhsXSxX73DSZtQCt4j0qCH78YvvmRLk2sGGRGEuKDY+rR54JS0jqVzp+prVnBt1xnurDAo4tOVxNqKX1zk129nNNsfBWzsbjvqXDap+4BrfHAwTBttPuQ1XsMD5ow6LoFG10kkGdEIYYHTJ4ae0YlxvNvqYOv6Upy1jov71FJ+OibwZE3dKUE104qnWLgSrdpta12WSrdLQLlo/frV9sdV44vvfCMIMQDB6NanQLVJFtqZLj/QNjm7I71KJewZ6exXbZgQ3XPeVqLPQOmlMD68UTno2P0yNGglPDMRMczSgk//nzwXpupNKGe4vYtdsWF3VVl1hUC5SVgFy/1v3W9rafQlA+18Ohzwf9+ppr6wYwkwMfH1X8cDZL2UunUYOUy3rXZdlWVWVcIlC+9uO16c8lSzsODJqQN3H/gXJM9nhEE2HcwqtURtHGdFMFaDA+aJOmilfNdIZDzKCW8Z8BaC5XnyCUcfl0f/aWuJDzbdLNnVBJ+/i196HVdaWNWWhFqKbZ8zW1f67pnPF/8s8xrx3asc9evHl964QGtcN+BsJFRy5WEmcUDByKl2urn4vKB3qBxvluyy644Te8xPDS+FJAZpRDvfkqPPx+US3zu5MYzygn/6AX99ifUTm8yTailuHWTvWJ5t1SZFVygfJp49UX+m9eNL71wjCTBw8+En55QcavhVV6p+NkX6pGjYRK3lUo3DJYt4Tu2mrQ7qswKLpBWaDRo9w1m6WLO2yEECvUUP3g6SGJW1LwP0NRDEZKYf3g4qKftpdIKxmDPTtNb6YoFGwXvUGYceisTSy8IzqOvgh8cCo68GiLgtNHut+zwK+FjzwV3brenqjj31GKeSm+43H/9avvYs2FfpeAjsqDY4edUlXZdb669zI+lUAQPNAz6F/M//n4tbrs7glJoZFi+eHL52LlhQGnsHTSPPRtKBOrwHAgYHjJagRkgKEJmsH2tG7zGwaPd2gsGFGyGNkvG8l5mN21w6y9xb36iSlGR+3gUVqC8dmz9SnfTBjs2tXECoZrC1+fzB6ntjDGzWHwef2uH+e79SSXmAgtU2CRaKWQZ3bXdLu6FmVLnpRUCjSiY85F33pzLf8ed2+yS89i4IleZFTMC5W17l/TxXdtNIxsPP0TwHrXG/D9OBuIQitpa8VNr4MpL/M0b7b4DRW4LHBQ1/Jweo12bzbqLfT5u8oxyhO/8fenJl3RvaT5JiSKM1nHTRvu930vbLPphYO9gtv/pkCUH6iwYCDT2Dpn8k8uXXrz8vtp/JHAOJ0bn02eeAMfY/3T4x7uytSt8vdW6n3zBxtDVbuMq94t3VTkuZipdwBwon4nZuMoNXWXP1I6FIR58OqzXqaeEKEQ89yMK0ZtgrEb7D4dRewMr69FTxt07swK3BS6mQMbQ3TtNT3m8dizWODZCDx8J4pitA/M8D+cRRfzQkeDkaUS6jfE8IU2xe6vtL25b4KIJlC+96D/f37HV5G17PaNcwhMv6jc/nlx6MT/yW+GrH+gnXwrKSeta6bzK7PJ+vnWzrRW0yqxoAuVLL27dZFf1j7ftJcA63H8gWqgAwIx9B+eQF+dtgeOQJQfqABwjDnl4YLwixzPKCV58Rx14dfrSi3kGIY9Kwv/5UvDah23lxXkqvW2t27LWjRWxyqxQJ5Qvvdiyxm1bO1E7lqfPh8KxGgV6IcIPEGqcPE0PHQmiqHWZIoreFlgV7GScxT0DJkngPBiIA3z2BT3yTJjECzaV5xlRxPsPh6dGEerWMwJn2gJfWsS2wMURKM9YL13md00svfAe5QQ/fiF4+xNVWri9Tj2jFOOV9/XPXwkqpbZ6maUGF13At2819cK1Eer4s1E0foQa9QbdtsWuuGB86QURnMO+Q2GgQRO/ptT8YwARlEJehgbgwUNhm39KKViDPTtNpcSex/9IfnQ6HT8TXW0QM4jytql8z2BmDRTBe/SUcOBV/cSLgdY4VaMzSUykOQrmPBlNgLFoWKL8sRrw8DPBL95RV17SelZaEaopNq32O9e7J54NoilTAEnEHa0R9fb2dugNy3skIf/td9Jli9hYeKAcY/Oq8cLlfBPC94+ptz5RYcD5/SvffPmBp8Lv/TTqncvmy4owltIt15k/vT0bq0OpvFUerb/ELV/Mpo1Jwon3Q299os+8HwL+5N7Sm5+qJOQOfV7WwREo7zU2dJVdsQw+g1LwHtXGpGHG4vKlft2KyV28rUPYhxfe1m6O88JEcBYrlvDgZndmT+e8Yt+096cm3g+vW2HPvB8Cvpuw9yB06jbQHX8LO1WjRWOTxaZ5bDhDmqE2pfDZOizWqDcwn5IOQsPCjmFkSlm0IhDNIT2vn/1+8ge0kgN9lZRilGPo9lJj6xDECOd70oFGEKNssFAjKULH59GdLRAzPjpBBGSmraDiPPpSjFRpHgMxIlRT+vhzOl1bsE89T8xJkuivkCiY8wfgPOy8+oLn5bALS2Y7u6lZx9/CUjPXqDU+RTQPrIOxWNgKZ7mFfcXMuUZCzf8bn08kLux4qdOf0He8QPyr/cRYdmqe/n0UBBFIEIEEEUgQgQRBBBJEIKFDCOQSfHl03sN15hQRgQDpUCacCyKcqo2XKU4j72rVk7A0VxBmyQAI1RS/+41sz6DJzl5xwYwwpH/5Wfj9Q2FPib20dxFm3rlGa3Tjtfaf/yAFN3nKQYSh9fa9z9VzbxW2O4cI9CVuXoCzWN3vQThxukmVmfW4oBeXLfWHX9OUMEQgYaZEmQVjvKn0TBgLXwEiw/iiJdF0zihV7A0PJAI1+chna4HgWco5RKBW4cQzRmtNggYzyjGHushNn0WgL2tPZhEHuGmDnVZpmmc5L76jjp+moo6nRKAvS77N5b1/WL9tmzVnr1bO28T899tq91+WPx2hLtzeW5LoFuT70m1d427bZk+eRq2BsXTyqDVwfAQb1/lCdtiQCLSQd7E89sxcLKEVfCZXSCJQyytC8/mRCCQIcgtrFjNma35AhO7ZnFsEmmdCU2vAOtK6iUPOo6fEclMSgWaJPQrVOm1fZ/9sd6aIwZMPpDyjFOHnLwd/9UgUanFABJoZewBj0b/Y/+sf1Vf2s5+xA7dn3LjZfTFG//B4tKinK3bHFYHmdvPKDJYt4vN7+eQIFE2vpLAOSzTW5s3L5DYmAjV1yHo417whC/P4/qmCDOPPdSM7dykFSewRgQQRSBCB/l/CrZoBzZwcavmIvclLuPXbkCS6I+3RCgR433zFlvfT82sGAgUGPDcZmXmG5yYpeaDHf6S4yUuYESgRqBNPTOF0lTyjt4RsRidUraBKODFK0+z5Yow0oRI3cSjQUBGOj052eGWAFE6MkgpRjppoGgEU4MRoAbcJm7yScRwXMvyEAY6dUh+eoGsv8yNVnKrRmWOkSpmjnxwN/+LBmPRkTIoDvH9Mjdax7mL+YrTJS+57Mvy7x+J4YsddZsQR3vhQhYTLlvnjp2naS1Kj/ubfw/ufisoJF7WIsePb/J57lF5NqbfEM3f1IsJIFYHCzNrCWoP6yjy+3P1sTlYpCVmfPS3JjHpGiyrc9EY5UqVSxAWeLyiyQACUgnNoMt3MCDS4WQqs1KxdpAMFbrY8UBFmexgSaHhprtC5eA9FzR5WqFkL472ftXXwrC/h2V9S9KdsxS9p5bmPrXmh/ovMAwmCCCSIQIIIJIhAgiACCSKQIAIJIpAgiECCCCSIQIIIJIhAgiACCSKQIAIJIpAgiECCCCSIQIIIJAgikCACCSKQIAIJgggkiECCCCSIQIIIJAgikCACCSKQIAIJgggkiECCCCSIQIIgAgkikCACCSKQIEzl/wCbp+TyqEPwGwAAAABJRU5ErkJggg==',
  '/icon-512.png': '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',
  '/apple-touch-icon.png': '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'
};
const APP_MANIFEST = JSON.stringify({
  name: 'The Avoca Dashboard', short_name: 'Avoca', start_url: '/', scope: '/',
  display: 'standalone', background_color: '#0D0D0D', theme_color: '#FAF7F2',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
});
const APP_HEAD = '<link rel="manifest" href="/manifest.webmanifest">' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">' +
  '<link rel="icon" type="image/png" href="/icon-192.png">' +
  '<meta name="theme-color" content="#FAF7F2">' +
  '<meta name="mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-capable" content="yes">' +
  '<meta name="apple-mobile-web-app-status-bar-style" content="default">' +
  '<meta name="apple-mobile-web-app-title" content="Avoca">';
function appAsset(path) {
  if (path === '/manifest.webmanifest') return new Response(APP_MANIFEST, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'public, max-age=86400' } });
  const b64 = APP_ICONS[path];
  if (!b64) return null;
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=604800' } });
}

/* ---------------- OAuth begin + callback (generic, per-source) ---------- */

function randomState() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ---------------- Owner login: one passcode + a signed session cookie ----
   The owner sets the dashboard password on the dashboard's own FIRST-RUN screen;
   it is stored PBKDF2-hashed in KV (sys:passcode_hash) - no Cloudflare Variables
   step. (env.DASHBOARD_PASSCODE still works as an override, e.g. when the
   one-click button collected it in its wizard.) The session-signing key is
   generated and stored in KV on first run (env.SESSION_SECRET overrides if set).
   Until a password exists the dashboard shows the SET-PASSWORD screen, never an
   open page; once set, the page and every data route require a valid session. */
const SESSION_TTL = 60 * 60 * 24 * 30;
/* A password exists if the owner set one (first-run -> KV) or the deploy provided
   one as an env override (the one-click button's wizard). */
async function passcodeSet(env) {
  if (env.DASHBOARD_PASSCODE) return true;
  if (env.TOKENS) return !!(await env.TOKENS.get('sys:passcode_hash'));
  return false;
}
/* PBKDF2-SHA256 of a passcode with a hex salt -> base64url (at-rest hashing). */
async function pbkdf2B64(passcode, saltHex) {
  const salt = Uint8Array.from((saltHex.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
  const km = await crypto.subtle.importKey('raw', new TextEncoder().encode(passcode), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' }, km, 256);
  return b64url(bits);
}
let _sessionKeyCache = null;
async function getSessionKey(env) {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (_sessionKeyCache) return _sessionKeyCache;
  if (env.TOKENS) {
    let k = await env.TOKENS.get('sys:session_secret');
    if (!k) {
      const b = new Uint8Array(32);
      crypto.getRandomValues(b);
      k = Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
      await env.TOKENS.put('sys:session_secret', k);
    }
    _sessionKeyCache = k;
    return k;
  }
  return env.DASHBOARD_PASSCODE || 'unset';
}
function b64url(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg)));
}
async function shaB64(s) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function makeSession(env) {
  const payload = 'v1.' + Math.floor(Date.now() / 1000);
  return payload + '.' + await hmacB64(await getSessionKey(env), payload);
}
async function validSession(env, token) {
  if (!token) return false;
  const i = token.lastIndexOf('.');
  if (i < 0) return false;
  const payload = token.slice(0, i);
  if (!timingSafeEqual(token.slice(i + 1), await hmacB64(await getSessionKey(env), payload))) return false;
  const issued = parseInt(payload.split('.')[1], 10);
  return !!issued && (Date.now() / 1000 - issued) <= SESSION_TTL;
}
function getCookie(request, name) {
  const m = (request.headers.get('Cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}
async function isLoggedIn(request, env) {
  return await validSession(env, getCookie(request, 'vd_session'));
}
function htmlResponse(html) {
  const hi = html.indexOf('<head>');
  if (hi >= 0) html = html.slice(0, hi + 6) + APP_HEAD + html.slice(hi + 6);
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' } });
}
async function apiLogin(env, request) {
  if (!(await passcodeSet(env))) return json({ ok: false, error: 'no_passcode' }, 400);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  let okPass = false;
  if (env.DASHBOARD_PASSCODE) {
    okPass = timingSafeEqual(await shaB64(passcode), await shaB64(env.DASHBOARD_PASSCODE));
  } else if (env.TOKENS) {
    const stored = await env.TOKENS.get('sys:passcode_hash');
    if (stored) {
      const dot = stored.indexOf('.');
      okPass = timingSafeEqual(await pbkdf2B64(passcode, stored.slice(0, dot)), stored.slice(dot + 1));
    }
  }
  if (!okPass) return json({ ok: false }, 401);
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}

/* First-run (or authenticated change): set the dashboard password. Allowed only
   when none is set yet, OR when the caller already holds a valid session - so a
   stranger can never overwrite an existing password. Stored PBKDF2-hashed in KV. */
async function apiSetup(env, request) {
  if (!env.TOKENS) return json({ ok: false, error: 'no_store' }, 400);
  if ((await passcodeSet(env)) && !(await isLoggedIn(request, env))) return json({ ok: false, error: 'exists' }, 403);
  let body; try { body = await request.json(); } catch (e) { return json({ ok: false }, 400); }
  const passcode = String((body && body.passcode) || '');
  if (passcode.length < 6) return json({ ok: false, error: 'too_short' }, 400);
  const saltB = new Uint8Array(16); crypto.getRandomValues(saltB);
  const saltHex = Array.from(saltB).map((x) => x.toString(16).padStart(2, '0')).join('');
  await env.TOKENS.put('sys:passcode_hash', saltHex + '.' + (await pbkdf2B64(passcode, saltHex)));
  const token = await makeSession(env);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=' + encodeURIComponent(token) + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + SESSION_TTL } });
}
function apiLogout() {
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': 'vd_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' } });
}
function loginPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Your dashboard</h1><p>Enter the password for this dashboard.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="current-password" placeholder="Password" autofocus>'
    + '<button type="submit">Sign in</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:document.getElementById("p").value})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="That password did not match. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

function setupPage() {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Set your password</title>'
    + '<link href="https://fonts.googleapis.com/css2?family=Khand:wght@600;700&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet">'
    + '<style>'
    + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#FAF7F2;font-family:"DM Sans",sans-serif;color:#2A2420}'
    + '.box{width:90%;max-width:360px;background:#fffdf9;border:1px solid rgba(13,13,13,0.08);border-radius:16px;padding:2rem 1.75rem}'
    + 'h1{font-family:"Khand",sans-serif;font-size:30px;font-weight:700;color:#0D0D0D;margin:0 0 0.4rem}'
    + 'p{font-size:14px;color:#8C8075;margin:0 0 1.25rem;line-height:1.6}'
    + 'input{width:100%;font-family:"DM Sans",sans-serif;font-size:15px;padding:12px 14px;border:1px solid rgba(13,13,13,0.14);border-radius:10px;background:#fff;color:#2A2420;box-sizing:border-box}'
    + 'input:focus{outline:none;border-color:#F2A900}'
    + 'button{width:100%;margin-top:12px;padding:13px;font-size:15px;font-weight:500;font-family:"DM Sans",sans-serif;color:#0D0D0D;background:#F2A900;border:none;border-radius:10px;cursor:pointer}'
    + '.err{color:#C04B28;font-size:13px;margin-top:10px;min-height:16px}'
    + '</style></head><body>'
    + '<div class="box"><h1>Set your password</h1><p>Choose a password for your dashboard. You\u2019ll type it each time you open it - pick something only you and your team know, at least 6 characters.</p>'
    + '<form id="f"><input id="p" type="password" autocomplete="new-password" placeholder="New password" autofocus>'
    + '<input id="p2" type="password" autocomplete="new-password" placeholder="Confirm password" style="margin-top:10px">'
    + '<button type="submit">Save and open my dashboard</button><div class="err" id="e"></div></form></div>'
    + '<script>'
    + 'var f=document.getElementById("f");'
    + 'f.onsubmit=function(ev){ev.preventDefault();var e=document.getElementById("e");e.textContent="";'
    + 'var p=document.getElementById("p").value,p2=document.getElementById("p2").value;'
    + 'if(p.length<6){e.textContent="Use at least 6 characters.";return;}'
    + 'if(p!==p2){e.textContent="The two passwords do not match.";return;}'
    + 'fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({passcode:p})})'
    + '.then(function(r){if(r.ok){location.reload();}else{e.textContent="Could not save that. Try again.";}})'
    + '.catch(function(){e.textContent="Something went wrong. Try again.";});};'
    + '</script></body></html>';
}

async function authStart(env, source, url) {
  const adapter = ADAPTERS[source];
  if (!adapter || adapter.auth !== 'oauth' || !adapter.oauth.authorizeUrl) {
    return new Response('This connection is not set up for browser authorisation yet.', { status: 404 });
  }
  const cfg = adapter.oauth;
  const state = randomState();
  await env.TOKENS.put('oauthstate:' + source, state, { expirationTtl: 600 });
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const p = new URLSearchParams({
    response_type: 'code',
    client_id: env[cfg.clientIdSecret] || '',
    redirect_uri: redirectUri,
    scope: cfg.scopes || '',
    state
  });
  return Response.redirect(cfg.authorizeUrl + '?' + p.toString(), 302);
}

async function authCallback(env, source, url) {
  const adapter = ADAPTERS[source];
  const cfg = (adapter && adapter.oauth) || {};
  const code = url.searchParams.get('code');
  const gotState = url.searchParams.get('state');
  const wantState = await env.TOKENS.get('oauthstate:' + source);
  if (!code || !gotState || gotState !== wantState) {
    return new Response('That authorisation didn’t complete cleanly. Go back to the dashboard and click Reconnect to try again.', { status: 400 });
  }
  await env.TOKENS.delete('oauthstate:' + source);
  const redirectUri = url.origin + '/auth/' + source + '/callback';
  const res = await fetch(cfg.tokenUrl, tokenRequestInit(cfg, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  }, env));
  if (!res.ok) {
    /* Show the provider's own reason code (e.g. invalid_client, invalid_grant):
       it names the cause and contains no secret. */
    let reason = '';
    try {
      const body = await res.text();
      let j = null; try { j = JSON.parse(body); } catch (e) {}
      reason = j ? [j.error, j.error_description].filter(Boolean).join(' - ') : body.slice(0, 200);
    } catch (e) {}
    console.log('oauth exchange failed for ' + source + ': ' + res.status + ' ' + reason);
    return new Response('The connection couldn’t be finished (the tool said no: ' + res.status + (reason ? ', reason: ' + reason : '') + '). Show this message to your AI.', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  const t = await res.json();
  await saveTokens(env, source, {
    access_token: t.access_token,
    refresh_token: t.refresh_token || null,
    token_type: t.token_type || 'Bearer',
    expires_at: Date.now() + ((t.expires_in || 1800) * 1000),
    obtained_at: new Date().toISOString()
  });
  await bumpDataVersion(env, source);
  /* After token storage, adapters' status() should resolve org name etc. */
  return Response.redirect(url.origin + '/', 302);
}

/* ---------------- No-API ingest: KV day-store + endpoint ---------------- */

/* Day rows live at data:<source>:<YYYY-MM-DD> as JSON objects of numeric
   fields. Same-day re-uploads overwrite (idempotent; re-ingesting a corrected
   export is safe and expected). */
async function saveIngestedRows(env, source, rows) {
  if (!Array.isArray(rows)) return 0;
  let saved = 0;
  for (const r of rows) {
    if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) continue;
    const clean = {};
    for (const [k, v] of Object.entries(r)) {
      if (k !== 'date' && typeof v === 'number' && isFinite(v)) clean[k] = v;
    }
    if (Object.keys(clean).length === 0) continue;
    await env.TOKENS.put('data:' + source + ':' + r.date, JSON.stringify(clean));
    saved++;
  }
  return saved;
}

function eachDate(from, to, cap) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d.getTime() <= end.getTime() && out.length < (cap || 400)) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/* Sum stored day rows across a range. Returns { sums, daysWithData, lastDate }. */
async function readIngested(env, source, from, to) {
  const sums = {};
  let daysWithData = 0, lastDate = null;
  for (const date of eachDate(from, to)) {
    const raw = await env.TOKENS.get('data:' + source + ':' + date);
    if (!raw) continue;
    daysWithData++; lastDate = date;
    try {
      const row = JSON.parse(raw);
      for (const [k, v] of Object.entries(row)) {
        if (typeof v === 'number' && isFinite(v)) sums[k] = (sums[k] || 0) + v;
      }
    } catch (e) { /* skip bad row */ }
  }
  return { sums, daysWithData, lastDate };
}

async function monthlyIngested(env, source, fromMonth, toMonth) {
  const months = monthList(fromMonth, toMonth);
  const out = { months, byMonth: [] };
  for (const mo of months) {
    const [y, m] = mo.split('-').map(Number);
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const r = await readIngested(env, source, mo + '-01', mo + '-' + String(lastDay).padStart(2, '0'));
    out.byMonth.push(r.daysWithData ? r.sums : null);
  }
  return out;
}

/* POST /api/ingest?source=pos|accounting|rostering
   Authorization: Bearer <INGEST_TOKEN>. Body: the exported file's text.
   The source's adapter.parseExport() turns it into day rows. */
async function apiIngest(env, request, url) {
  const source = url.searchParams.get('source');
  if (!['accounting', 'pos', 'rostering'].includes(source)) return json({ error: 'unknown source' }, 400);
  const auth = request.headers.get('Authorization') || '';
  if (!env.INGEST_TOKEN || auth !== 'Bearer ' + env.INGEST_TOKEN) {
    return json({ error: 'not authorised', plain: 'That upload code didn\u2019t match. Check it with your AI and try again.' }, 401);
  }
  const adapter = ADAPTERS[source];
  if (!adapter || typeof adapter.parseExport !== 'function') {
    return json({ error: 'no parser', plain: 'This source isn\u2019t set up for file uploads yet. Your AI adds that when this path is chosen.' }, 501);
  }
  const text = await request.text();
  if (text.length > 2000000) return json({ error: 'too big', plain: 'That file is too large. Export a shorter date range and try again.' }, 413);
  try {
    const rows = await adapter.parseExport(env, makeHelpers(env, source), {
      text, contentType: request.headers.get('Content-Type') || ''
    });
    const saved = typeof adapter.saveExport === 'function'
      ? await adapter.saveExport(env, rows)
      : await saveIngestedRows(env, source, rows);
    if (!saved) return json({ error: 'nothing parsed', plain: 'No usable rows were found in that file. Check it\u2019s the right report, or show it to your AI.' }, 422);
    await noteSync(env, source);
    await bumpDataVersion(env, source);
    return json({ ok: true, days: saved });
  } catch (e) {
    return json({ error: 'parse failed', plain: (e && e.plain) || 'That file couldn\u2019t be read. Check it\u2019s the right report, or show it to your AI.' }, 422);
  }
}

/* ---------------- Metrics API ---------------- */

function parseRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/.exec(s);
  return m ? { from: m[1], to: m[2] } : null;
}
function parseMonthRange(s) {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}):(\d{4}-\d{2})$/.exec(s);
  return m ? { fromMonth: m[1], toMonth: m[2] } : null;
}

async function sourceStatus(env, source) {
  const adapter = ADAPTERS[source];
  if (!adapter || !adapter.configured) return { configured: false };
  try {
    const h = makeHelpers(env, source);
    const st = await adapter.status(env, h);
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: !!(st && st.connected),
      org: (st && st.org) || null,
      sandbox: !!(st && st.sandbox),
      lastSync: (st && st.lastSync) || (await lastSync(env, source)) || null,
      error: null
    };
  } catch (err) {
    return {
      configured: true,
      ingest: typeof adapter.parseExport === 'function',
      connected: false,
      org: null,
      sandbox: false,
      lastSync: (await lastSync(env, source)) || null,
      error: { code: err.status || 0, plain: plainError(err.status || 500) }
    };
  }
}

/* Per-source caching: each source's pull for a given range is cached on its
   own, keyed with that source's data version (bumped on upload / connect /
   disconnect). So uploading a Lightspeed file never re-pulls Xero, and a
   failed pull is never cached. ?refresh=1 (the Refresh button) bypasses. */
const SLOT_CACHE_TTL = 1800;   /* 30 min */
const TREND_CACHE_TTL = 3600;  /* 1 hour */

async function dataVersion(env, source) {
  return (env.TOKENS && (await env.TOKENS.get('cachev:' + source))) || '0';
}
async function bumpDataVersion(env, source) {
  if (env.TOKENS) await env.TOKENS.put('cachev:' + source, String(Date.now()));
}
async function cached(env, key, ttl, force, producer) {
  if (!force && env.TOKENS) {
    try { const c = await env.TOKENS.get(key); if (c) return JSON.parse(c); } catch (e) {}
  }
  const val = await producer(); /* throws on failure -> nothing cached */
  if (env.TOKENS) { try { await env.TOKENS.put(key, JSON.stringify(val), { expirationTtl: ttl }); } catch (e) {} }
  return val;
}

async function fetchSlot(env, q, ctx) {
  /* One period slot: pull each configured source; null where unavailable. */
  const out = {};
  await Promise.all(['accounting', 'pos', 'rostering'].map(async function (source) {
    const adapter = ADAPTERS[source];
    if (!adapter || !adapter.configured) { out[source] = null; return; }
    try {
      const h = makeHelpers(env, source);
      const key = 'slot:' + source + ':' + ctx.versions[source] + ':' + q.from + ':' + q.to + ':' + q.tz + ':' + q.rollover;
      out[source] = await cached(env, key, SLOT_CACHE_TTL, ctx.force, async function () {
        const v = await adapter.fetchRange(env, h, q);
        /* export-fed sources: "last synced" means last upload, not last read */
        if (adapter.mode !== 'export') await noteSync(env, source);
        return v;
      });
    } catch (err) {
      out[source] = null; /* per-source failure never breaks the whole payload */
      ctx.errors[source] = err.status || 500;
      console.log('fetch failed for ' + source + ': ' + (err && err.message));
    }
  }));
  return out;
}

async function apiMetrics(env, url) {
  const cur = parseRange(url.searchParams.get('cur'));
  if (!cur) return json({ error: 'bad cur range' }, 400);
  const prev = parseRange(url.searchParams.get('prev'));
  const yoy = parseRange(url.searchParams.get('yoy'));
  const trend = parseMonthRange(url.searchParams.get('trend'));
  const tz = url.searchParams.get('tz') || 'Australia/Sydney';
  const rollover = Math.max(0, Math.min(6, parseInt(url.searchParams.get('rollover') || '0', 10) || 0));
  const force = url.searchParams.get('refresh') === '1';
  const base = { tz, rollover };

  const [sAcc, sPos, sRos, vAcc, vPos, vRos] = await Promise.all([
    sourceStatus(env, 'accounting'), sourceStatus(env, 'pos'), sourceStatus(env, 'rostering'),
    dataVersion(env, 'accounting'), dataVersion(env, 'pos'), dataVersion(env, 'rostering')
  ]);
  const ctx = { force, errors: {}, versions: { accounting: vAcc, pos: vPos, rostering: vRos } };

  /* Refresh any OAuth token ONCE before fetching in parallel: Xero rotates
     refresh tokens, so concurrent refreshes would invalidate each other. */
  for (const source of ['accounting', 'pos', 'rostering']) {
    const a = ADAPTERS[source];
    if (a && a.configured && a.auth === 'oauth') { try { await getValidAccessToken(env, source); } catch (e) {} }
  }

  const trendTask = (async function () {
    if (!trend) return null;
    const out = { months: monthList(trend.fromMonth, trend.toMonth) };
    await Promise.all(['accounting', 'pos'].map(async function (source) {
      const adapter = ADAPTERS[source];
      if (!adapter || !adapter.configured) { out[source] = null; return; }
      try {
        const h = makeHelpers(env, source);
        const key = 'trend:' + source + ':' + ctx.versions[source] + ':' + trend.fromMonth + ':' + trend.toMonth + ':' + tz + ':' + rollover;
        out[source] = await cached(env, key, TREND_CACHE_TTL, force, async function () {
          return alignSeries(out.months, await adapter.fetchMonthly(env, h, { ...base, ...trend }));
        });
      } catch (err) {
        out[source] = null;
        ctx.errors[source] = ctx.errors[source] || err.status || 500;
        console.log('trend failed for ' + source + ': ' + (err && err.message));
      }
    }));
    return out;
  })();

  const [pc, pp, py, trendOut] = await Promise.all([
    fetchSlot(env, { ...base, ...cur }, ctx),
    prev ? fetchSlot(env, { ...base, ...prev }, ctx) : null,
    yoy ? fetchSlot(env, { ...base, ...yoy }, ctx) : null,
    trendTask
  ]);

  /* Surface a failed pull on the Connections screen instead of silent blanks. */
  [['accounting', sAcc], ['pos', sPos], ['rostering', sRos]].forEach(function (pair) {
    const code = ctx.errors[pair[0]];
    if (code && pair[1] && pair[1].configured && !pair[1].error) pair[1].error = { code: code, plain: plainError(code) };
  });

  return json({
    generatedAt: new Date().toISOString(),
    protected: true,
    sources: { accounting: sAcc, pos: sPos, rostering: sRos },
    periods: { cur: pc, prev: pp, yoy: py },
    trend: trendOut
  });
}

function monthList(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split('-').map(Number);
  const [ey, em] = toMonth.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(y + '-' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 60) break;
  }
  return out;
}
/* Adapters return {months:[...], <field>:[...]} - align onto the requested grid. */
function alignSeries(months, series) {
  if (!series || !Array.isArray(series.months)) return null;
  const idx = {};
  series.months.forEach((mo, i) => { idx[mo] = i; });
  const out = {};
  Object.keys(series).forEach((k) => {
    if (k === 'months') return;
    out[k] = months.map((mo) => (mo in idx && series[k] ? (series[k][idx[mo]] ?? null) : null));
  });
  return out;
}

/* ---------------- Router ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/favicon.ico') return new Response(null, { status: 204 });
    { const asset = appAsset(path); if (asset) return asset; }
    if (path === '/api/login' && request.method === 'POST') return apiLogin(env, request);
    if (path === '/api/setup' && request.method === 'POST') return apiSetup(env, request);
    if (path === '/api/logout' && request.method === 'POST') return apiLogout();
    if (path === '/api/ingest' && request.method === 'POST') return apiIngest(env, request, url);

    const loggedIn = await isLoggedIn(request, env);

    if (path === '/' || path === '/index.html') {
      if (loggedIn) return htmlResponse(await dashboardPage(env));
      return htmlResponse((await passcodeSet(env)) ? loginPage() : setupPage());
    }
    if (path === '/api/uistate' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiUiState(env, request);
    }
    if (path === '/api/metrics' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiMetrics(env, url);
    }
    if (path === '/api/accounting/breakdown' && request.method === 'GET') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      return apiAccountingBreakdown(env, url);
    }
    const authRoute = /^\/auth\/(accounting|pos|rostering)\/(start|callback)$/.exec(path);
    if (authRoute && request.method === 'GET') {
      if (!loggedIn) return Response.redirect(url.origin + '/', 302);
      return authRoute[2] === 'start' ? authStart(env, authRoute[1], url) : authCallback(env, authRoute[1], url);
    }
    if (path === '/api/disconnect' && request.method === 'POST') {
      if (!loggedIn) return json({ error: 'auth' }, 401);
      const source = url.searchParams.get('source');
      if (['accounting', 'pos', 'rostering'].includes(source)) {
        await clearTokens(env, source);
        await bumpDataVersion(env, source);
        return json({ ok: true });
      }
      return json({ error: 'unknown source' }, 400);
    }
    return new Response('Not found', { status: 404 });
  },

  /* Cron rung: uncomment [triggers] in wrangler.toml and give any adapter a
     scheduledPull() to fetch its tool's own export on a schedule. */
  async scheduled(event, env, ctx) {
    for (const source of ['accounting', 'pos', 'rostering']) {
      const a = ADAPTERS[source];
      if (a && typeof a.scheduledPull === 'function') {
        try {
          await a.scheduledPull(env, makeHelpers(env, source));
          await noteSync(env, source);
        } catch (e) {
          console.log('scheduledPull failed for ' + source + ': ' + (e && e.message));
        }
      }
    }
  },

  /* Email rung (Path B): the tool's own report scheduler emails its export;
     the owner's domain on their Cloudflare routes that address here (Email
     Routing -> this Worker). Complete when this rung is chosen:
       1. parse the message with postal-mime (add the dependency)
       2. find the CSV/report attachment, work out which source sent it
          (sender address or subject)
       3. reuse adapter.parseExport + saveIngestedRows + noteSync, exactly
          like /api/ingest
     Until then this logs and discards. */
  async email(message, env, ctx) {
    console.log('email received from ' + message.from + '; email ingest not wired yet');
  }
};
// EOF worker.js
