import * as fs from 'fs';
import * as http from 'http';

import polka from 'polka';

import {ALL_SLOTS, SETTLED_MAX_SE, SETTLED_MIN_MATCHES} from '../db';
import type * as db from '../db';
import {header, injectLiveBanner, renderErrorPage, renderer} from '../static/build';
import * as util from '../static/util';

import type * as arena from './arena';
import {Auth, isAdmin, isCrossSiteRequest} from './auth';
import * as system from './system';
import {formatTournamentName} from './tournaments';

export interface Options {
  db: db.Database;
  auth: Auth;
  arena?: arena.Handle;
  vpsMonitor?: system.VpsHostMonitor;
  getVpsSystem?: (now: number) => system.VpsSystemInfo;
  now?: () => number;
}

export interface Handle {
  notifyHeartbeat: () => void;
  getAdminStreamCount: () => number;
  close: () => void;
}

export interface AdminSystemSnapshot {
  vps: system.VpsSystemInfo;
  arena?: system.ArenaSystemInfo;
  lastHeartbeatAt?: number;
}

export interface RunnerHealth {
  status: 'online' | 'stale' | 'idle';
  lastContactAt?: number;
  liveMatch?: {
    ladderId: string;
    p1: string;
    p2: string;
  };
}

export interface AdminLadderItem {
  ladder: db.LadderRow;
  summary: db.LadderAdminSummary;
}

export interface AdminPoolProgress {
  ladderId: string;
  ladderName: string;
  required: number;
  saved: number;
  pending: number;
  active: number;
}

export interface AdminAgentItem {
  agent: db.AgentRow;
  developers: db.DeveloperRow[];
  qualifiedLadders: db.LadderSlot[];
  submissionStatus: db.SubmissionStatus;
  pools: AdminPoolProgress[];
  tournaments: db.AgentTournamentEntryView[];
  entries: db.AdminEntryView[];
  versions: db.VersionHistoryView[];
}

export interface AdminPendingItem {
  versionId: number;
  agentSlug: string;
  agentName: string;
  version: string;
  ladders: string[];
  tournaments: string[];
  submittedAt: number;
}

export interface AdminSnapshot {
  generatedAt: number;
  admin: string;
  system: AdminSystemSnapshot;
  health: {
    runner: RunnerHealth;
    pendingSubmissions: AdminPendingItem[];
    unsentDmCount: number;
    discordMemberCount: number;
  };
  ladders: AdminLadderItem[];
  agents: AdminAgentItem[];
}

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const SSE_KEEPALIVE_MILLIS = 25_000;
const HEARTBEAT_PUSH_THROTTLE_MILLIS = 3000;
const BACKUP_STALE_SECONDS = 26 * 3600;
const ARCHIVE_STALE_SECONDS = 36 * 3600;
const HEARTBEAT_STALE_SECONDS = 15 * 60;
const DISK_WARN_PCT = 80;
const DISK_CRIT_PCT = 90;
const TLS_WARN_DAYS = 30;
const TLS_CRIT_DAYS = 14;
const INTERNAL_RTT_WARN_MILLIS = 250;
const EXTERNAL_RTT_WARN_MILLIS = 500;
const P95_WARN_MILLIS = 200;
const P95_CRIT_MILLIS = 500;
const FAULT_RATE_WARN_PCT = 5;
const FAULT_RATE_CRIT_PCT = 15;
const RATE_LIMIT_WARN_COUNT = 10;
const SWAP_WARN_BYTES = 1024 ** 3;
const REPO_COMMIT_URL = 'https://github.com/pkmn/ai/commit/';
const SLOT_LABELS: Record<db.LadderSlot, string> = {
  rby: 'RBY',
  adv: 'ADV',
  sv: 'SV',
  rand: 'RAND',
  vgc: 'VGC',
};

const STYLE = fs.readFileSync(util.root('static', 'style', 'admin.css'), 'utf8');

const ADMIN_SCRIPT = `
  document.addEventListener('DOMContentLoaded', () => {
    const feedback = document.getElementById('admin-feedback');
    const showFeedback = (msg, isError) => {
      if (!feedback) return;
      feedback.textContent = msg;
      feedback.className = 'admin-feedback ' + (isError ? 'no' : 'yes');
    };

    const formatAdminReason = (reason) => {
      if (!reason) return '';
      let m = /^14-day cooldown active \\((\\d+d) remaining after .+\\)\\.$/.exec(reason);
      if (m) return m[1] + ' cooldown remaining.';
      m = /^Active version (\\S+) on (\\S+) has not settled \\((.+)\\)\\.$/.exec(reason);
      if (m) return 'Unsettled ' + m[2] + ' ' + m[1] + ' (' + m[3] + ').';
      if (reason === 'Project qualification is pending staff review.') {
        return 'Pending staff review.';
      }
      return reason;
    };

    const pad2 = (n) => String(n).padStart(2, '0');
    const fmtLocalDateTime = (sec) => {
      const d = new Date(sec * 1000);
      let tz = '';
      try {
        const parts = new Intl.DateTimeFormat(undefined, {timeZoneName: 'short'}).formatToParts(d);
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        if (tzPart) tz = tzPart.value;
      } catch {}
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
        pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()) +
        (tz ? ' ' + tz : '');
    };
    const fmtLocalDate = (sec) => {
      const d = new Date(sec * 1000);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    };
    const localizeTimestamps = (root) => {
      const scope = root || document;
      scope.querySelectorAll('time[data-epoch]').forEach(el => {
        const sec = Number(el.dataset.epoch);
        if (!Number.isFinite(sec)) return;
        el.textContent = el.dataset.fmt === 'date' ? fmtLocalDate(sec) : fmtLocalDateTime(sec);
      });
      scope.querySelectorAll('[data-title-tmpl][data-title-epochs]').forEach(el => {
        const tmpl = el.dataset.titleTmpl;
        const epochs = el.dataset.titleEpochs.split(',').map(Number);
        if (!tmpl) return;
        el.title = tmpl.replace(/\\{(\\d+)\\}/g, (_, idx) => {
          const sec = epochs[Number(idx)];
          return Number.isFinite(sec) ? fmtLocalDateTime(sec) : '';
        });
      });
    };
    localizeTimestamps(document);

    const postJson = async (url, body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || ('Request failed (' + res.status + ')'));
      }
      return data;
    };

    document.querySelectorAll('input.ladder-toggle').forEach(cb => {
      cb.addEventListener('change', async () => {
        const slug = cb.dataset.agent;
        const slot = cb.dataset.slot;
        const qualified = cb.checked;
        cb.disabled = true;
        try {
          const data = await postJson(
            '/api/admin/agents/' + encodeURIComponent(slug) + '/ladders',
            {slot, qualified}
          );
          const row = cb.closest('tr');
          if (row && data.submissionStatus) {
            const labelEl = row.querySelector('.status-label');
            const reasonEl = row.querySelector('.status-reason');
            const st = data.submissionStatus;
            if (labelEl) {
              labelEl.textContent = st.label;
              labelEl.className = 'status-label ' + (
                st.label === 'Eligible' ? 'yes' : st.label === 'Ineligible' ? 'no' : 'muted'
              );
            }
            if (reasonEl) {
              reasonEl.textContent = formatAdminReason(st.reason || '');
              reasonEl.title = st.reason || '';
              reasonEl.classList.toggle('hide', !st.reason);
            }
          }
          showFeedback(
            (qualified ? 'Enabled ' : 'Disabled ') + slot.toUpperCase() + ' for ' + slug + '.',
            false
          );
        } catch (err) {
          cb.checked = !qualified;
          showFeedback(err.message || 'Failed updating ladder eligibility.', true);
        } finally {
          cb.disabled = false;
        }
      });
    });

    const toggleProjectRow = (row) => {
      const slug = row.dataset.agentRow;
      if (!slug) return;
      const detailRow = document.querySelector('tr[data-detail-for="' + slug + '"]');
      if (!detailRow) return;
      const open = detailRow.classList.contains('hide');
      detailRow.classList.toggle('hide', !open);
      row.classList.toggle('expanded', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    document.querySelectorAll('tr.project-row').forEach(row => {
      row.addEventListener('click', (ev) => {
        if (ev.target && ev.target.closest('a, button, input, label')) return;
        toggleProjectRow(row);
      });
      row.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') {
          if (ev.target && ev.target.closest('a, button, input, label')) return;
          ev.preventDefault();
          toggleProjectRow(row);
        }
      });
    });

    document.querySelectorAll('button[data-action="refund"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.agent;
        btn.disabled = true;
        try {
          await postJson('/api/admin/agents/' + encodeURIComponent(slug) + '/refund-cooldown', {});
          window.location.reload();
        } catch (err) {
          btn.disabled = false;
          showFeedback(err.message || 'Failed refunding cooldown.', true);
        }
      });
    });

    document.querySelectorAll('button[data-action="unquarantine"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const slug = btn.dataset.agent;
        const version = btn.dataset.version;
        btn.disabled = true;
        try {
          await postJson(
            '/api/admin/versions/' + encodeURIComponent(slug) + '/' +
              encodeURIComponent(version) + '/unquarantine',
            {}
          );
          window.location.reload();
        } catch (err) {
          btn.disabled = false;
          showFeedback(err.message || 'Failed unquarantining version.', true);
        }
      });
    });

    document.querySelectorAll('button[data-action="retire"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.action-group');
        if (!group || group.querySelector('.confirm-retire')) return;
        btn.classList.add('hide');

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn-sm btn-danger confirm-retire';
        confirmBtn.textContent = 'Confirm retire';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-sm';
        cancelBtn.textContent = 'Cancel';

        const cleanup = () => {
          confirmBtn.remove();
          cancelBtn.remove();
          btn.classList.remove('hide');
        };

        cancelBtn.addEventListener('click', cleanup);
        confirmBtn.addEventListener('click', async () => {
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          try {
            await postJson(
              '/api/admin/ladders/' + encodeURIComponent(btn.dataset.ladder) +
                '/entries/' + encodeURIComponent(btn.dataset.agent) + '/' +
                encodeURIComponent(btn.dataset.version) + '/retire',
              {}
            );
            window.location.reload();
          } catch (err) {
            cleanup();
            showFeedback(err.message || 'Failed retiring entry.', true);
          }
        });

        group.appendChild(confirmBtn);
        group.appendChild(cancelBtn);
      });
    });

    document.querySelectorAll('button[data-action="quarantine"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('.action-group');
        if (!group || group.querySelector('.confirm-quarantine')) return;
        btn.classList.add('hide');

        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'reason-input';
        input.placeholder = 'Reason (optional)';
        input.maxLength = 240;

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'btn-sm btn-danger confirm-quarantine';
        confirmBtn.textContent = 'Confirm';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'btn-sm';
        cancelBtn.textContent = 'Cancel';

        const cleanup = () => {
          input.remove();
          confirmBtn.remove();
          cancelBtn.remove();
          btn.classList.remove('hide');
        };

        cancelBtn.addEventListener('click', cleanup);
        confirmBtn.addEventListener('click', async () => {
          confirmBtn.disabled = true;
          cancelBtn.disabled = true;
          input.disabled = true;
          try {
            await postJson(
              '/api/admin/versions/' + encodeURIComponent(btn.dataset.agent) + '/' +
                encodeURIComponent(btn.dataset.version) + '/quarantine',
              {reason: input.value.trim() || undefined}
            );
            window.location.reload();
          } catch (err) {
            cleanup();
            showFeedback(err.message || 'Failed quarantining version.', true);
          }
        });

        group.appendChild(input);
        group.appendChild(confirmBtn);
        group.appendChild(cancelBtn);
        input.focus();
      });
    });

    const formatAge = (sec) => {
      const s = Math.max(0, Math.floor(sec));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h';
      return Math.floor(s / 86400) + 'd';
    };

    const sysCards = document.getElementById('system-cards');
    let lastHbAt = sysCards && sysCards.dataset.heartbeatAt
      ? Number(sysCards.dataset.heartbeatAt)
      : NaN;
    let clockOffsetSec = sysCards && sysCards.dataset.generatedAt
      ? Number(sysCards.dataset.generatedAt) - Math.floor(Date.now() / 1000)
      : 0;

    const tickHbAge = () => {
      const el = document.getElementById('admin-hb-age');
      if (!el || !Number.isFinite(lastHbAt)) return;
      const nowSec = Math.floor(Date.now() / 1000) + clockOffsetSec;
      const ageSec = Math.max(0, nowSec - lastHbAt);
      el.textContent = formatAge(ageSec) + ' ago';
      el.className = ageSec > 900 ? 'no' : 'yes';
    };

    setInterval(tickHbAge, 1000);

    if (typeof EventSource !== 'undefined' && sysCards) {
      const es = new EventSource('/api/admin/stream');
      es.addEventListener('system', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (typeof payload.generatedAt === 'number') {
            clockOffsetSec = payload.generatedAt - Math.floor(Date.now() / 1000);
          }
          if (typeof payload.lastHeartbeatAt === 'number') {
            lastHbAt = payload.lastHeartbeatAt;
            sysCards.dataset.heartbeatAt = String(lastHbAt);
          }
          if (typeof payload.cardsHtml === 'string') {
            sysCards.innerHTML = payload.cardsHtml;
            localizeTimestamps(sysCards);
          }
        } catch {}
      });
    }
  });
`;

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(html);
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(JSON.stringify(payload));
}

function redirect(res: http.ServerResponse, location: string) {
  res.writeHead(302, {
    Location: location,
    'Cache-Control': 'private, no-store',
  });
  res.end();
}

function decodeParam(raw: string | string[] | undefined): string {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    return decodeURIComponent(raw).trim();
  } catch {
    return raw.trim();
  }
}

function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(2)} TiB`;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function formatRate(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 ** 2) return `${(bytesPerSec / 1024 ** 2).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(0)} KB/s`;
  return `${bytesPerSec} B/s`;
}

function formatUtcTimestamp(epochSeconds: number): string {
  return `${new Date(epochSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

interface LocalizedTitleAttrs {
  title: string;
  'data-title-tmpl'?: string;
  'data-title-epochs'?: string;
}

type TitlePart = string | {prefix?: string; epoch: number; suffix?: string};

function buildLocalizedTitle(parts: TitlePart[]): LocalizedTitleAttrs | Record<string, never> {
  if (parts.length === 0) return {};
  const fallback: string[] = [];
  const tmpl: string[] = [];
  const epochs: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      fallback.push(part);
      tmpl.push(part);
    } else {
      const idx = epochs.length;
      epochs.push(part.epoch);
      const pre = part.prefix ?? '';
      const suf = part.suffix ?? '';
      fallback.push(`${pre}${formatUtcTimestamp(part.epoch)}${suf}`);
      tmpl.push(`${pre}{${idx}}${suf}`);
    }
  }
  if (epochs.length === 0) return {title: fallback.join(' · ')};
  return {
    title: fallback.join(' · '),
    'data-title-tmpl': tmpl.join(' · '),
    'data-title-epochs': epochs.join(','),
  };
}

function formatAdminReason(reason?: string): string {
  if (!reason) return '';
  let m = /^14-day cooldown active \((\d+d) remaining after .+\)\.$/.exec(reason);
  if (m) return `${m[1]} cooldown remaining.`;
  m = /^Active version (\S+) on (\S+) has not settled \((.+)\)\.$/.exec(reason);
  if (m) return `Unsettled ${m[2]} ${m[1]} (${m[3]}).`;
  if (reason === 'Project qualification is pending staff review.') {
    return 'Pending staff review.';
  }
  return reason;
}

function formatFaultCounts(crashes: number, timeouts: number, ooms: number): string[] {
  const out: string[] = [];
  if (crashes > 0) out.push(`${crashes} ${crashes === 1 ? 'crash' : 'crashes'}`);
  if (timeouts > 0) out.push(`${timeouts} ${timeouts === 1 ? 'timeout' : 'timeouts'}`);
  if (ooms > 0) out.push(`${ooms} ${ooms === 1 ? 'OOM' : 'OOMs'}`);
  return out;
}

function diskPct(d: system.DiskMetrics): number | undefined {
  if (!d.mounted || !d.totalBytes || d.totalBytes <= 0 || d.usedBytes === undefined) {
    return undefined;
  }
  return Math.round((d.usedBytes / d.totalBytes) * 100);
}

function renderDiskRow(d: system.DiskMetrics): util.Child {
  const isRoot = d.mount === '/';
  const prefix = isRoot ? undefined : d.label;
  if (!d.mounted) {
    return (
      <span className='sys-line' title={d.mount}>
        {prefix && <>{prefix} </>}
        <span className='no'>UNMOUNTED</span>
      </span>
    );
  }
  const pct = diskPct(d);
  const pctClass = pct !== undefined && pct >= DISK_CRIT_PCT
    ? 'no'
    : pct !== undefined && pct >= DISK_WARN_PCT ? 'warn' : undefined;
  const totalIo = d.readBytesPerSec !== undefined && d.writeBytesPerSec !== undefined
    ? d.readBytesPerSec + d.writeBytesPerSec
    : d.ioBytesPerSec;
  const ioParts: string[] = [];
  if (totalIo !== undefined) ioParts.push(formatRate(totalIo));
  if (d.iops !== undefined) ioParts.push(`${d.iops} IOPS`);
  const busyHigh = d.busyPct !== undefined && d.busyPct >= 80;
  const tipParts: string[] = [d.mount];
  if (d.readBytesPerSec !== undefined && d.writeBytesPerSec !== undefined) {
    tipParts.push(`R ${formatRate(d.readBytesPerSec)} · W ${formatRate(d.writeBytesPerSec)}`);
  }
  if (d.busyPct !== undefined) tipParts.push(`${d.busyPct}% busy`);
  return (
    <span className='sys-line' title={tipParts.join(' · ')}>
      {prefix && <><span className='muted'>{prefix}</span>{' '}</>}
      {d.usedBytes !== undefined && d.totalBytes !== undefined ? (
        <span className={pctClass}>
          {formatBytes(d.usedBytes)} / {formatBytes(d.totalBytes)} ({pct}%)
        </span>
      ) : (
        <span className='muted'>mounted</span>
      )}
      {ioParts.length > 0 && (
        <> · <span className={busyHigh ? 'warn' : 'muted'}>{ioParts.join(' · ')}</span></>
      )}
    </span>
  );
}

function renderMemoryRow(mem: system.MemoryMetrics): util.Child {
  const pct = mem.totalBytes > 0 ? Math.round((mem.usedBytes / mem.totalBytes) * 100) : 0;
  const memClass = pct >= 90 ? 'no' : pct >= 80 ? 'warn' : undefined;
  const swapPct = mem.swapTotalBytes > 0
    ? Math.round((mem.swapUsedBytes / mem.swapTotalBytes) * 100)
    : 0;
  const swapClass = swapPct >= 75 || mem.swapUsedBytes >= SWAP_WARN_BYTES ? 'warn' : 'muted';
  const abnormalPressure = mem.pressure === 'warning' || mem.pressure === 'critical';
  return (
    <>
      <span className={memClass}>
        {formatBytes(mem.usedBytes)} / {formatBytes(mem.totalBytes)} ({pct}%)
      </span>
      {' · '}
      <span className={swapClass}>
        Swap {formatBytes(mem.swapUsedBytes)} / {formatBytes(mem.swapTotalBytes)}
      </span>
      {' · '}
      <span className='muted'>RSS {formatBytes(mem.processRssBytes)}</span>
      {abnormalPressure && (
        <>
          {' · '}
          <span className={mem.pressure === 'critical' ? 'no' : 'warn'}>
            pressure {mem.pressure}
          </span>
        </>
      )}
    </>
  );
}

function renderUpdatesRow(updates: system.UpdateStatus | undefined): util.Child {
  if (!updates) return <span className='muted'>unavailable</span>;
  const hasSec = (updates.security ?? 0) > 0;
  const countClass = hasSec ? 'no' : updates.pending > 0 ? 'warn' : 'yes';
  const titleParts: TitlePart[] = [{prefix: 'Checked ', epoch: updates.checkedAt}];
  if (updates.summary) titleParts.push(updates.summary);
  const titleAttrs = buildLocalizedTitle(titleParts);
  return (
    <>
      <span className={countClass} {...titleAttrs}>
        {updates.pending === 0
          ? 'Up to date'
          : `${updates.pending} pending${hasSec ? ` (${updates.security} security)` : ''}`}
      </span>
      {updates.rebootRequired && (
        <> · <span className='no'>Reboot required</span></>
      )}
    </>
  );
}

function renderProbeBadge(
  probe: system.NetworkProbe | undefined,
  fallback: string,
  warnRttMillis: number
): util.Child {
  if (!probe) return <span className='muted'>{fallback}</span>;
  if (probe.ok) {
    const slow = probe.rttMillis !== undefined && probe.rttMillis > warnRttMillis;
    const titleAttrs = buildLocalizedTitle([{prefix: 'Checked ', epoch: probe.checkedAt}]);
    return (
      <span className={slow ? 'warn' : 'yes'} {...titleAttrs}>
        {probe.target}
        {probe.rttMillis !== undefined ? ` ${probe.rttMillis}ms` : ' ok'}
      </span>
    );
  }
  const titleParts: TitlePart[] = [];
  if (probe.error) titleParts.push(probe.error);
  titleParts.push({prefix: 'Checked ', epoch: probe.checkedAt});
  return (
    <span className='no' {...buildLocalizedTitle(titleParts)}>
      {probe.target} {probe.error ?? 'down'}
    </span>
  );
}

function buildBackupTooltip(b: system.BackupStatus): LocalizedTitleAttrs | Record<string, never> {
  const parts: TitlePart[] = [];
  if (b.lastBackupAt !== undefined) parts.push({prefix: 'Backup: ', epoch: b.lastBackupAt});
  if (b.lastArchiveUploadAt !== undefined) {
    parts.push({prefix: 'GCS sync: ', epoch: b.lastArchiveUploadAt});
  }
  if (b.checkedAt !== undefined) parts.push({prefix: 'Checked: ', epoch: b.checkedAt});
  return buildLocalizedTitle(parts);
}

function renderBackupDbPart(b: system.BackupStatus, now: number): util.Child {
  if (b.lastBackupAt === undefined) {
    return <span className='no'>DB none</span>;
  }
  const age = now - b.lastBackupAt;
  const stale = age > BACKUP_STALE_SECONDS;
  const metaParts: string[] = [];
  if (b.lastBackupBytes !== undefined) metaParts.push(formatBytes(b.lastBackupBytes));
  if (b.backupCount !== undefined) metaParts.push(`${b.backupCount} kept`);
  return (
    <>
      <span className={stale ? 'warn' : 'yes'}>DB {formatAge(age)} ago</span>
      {metaParts.length > 0 && (
        <> <span className='muted'>({metaParts.join(' · ')})</span></>
      )}
    </>
  );
}

function renderHostMeta(info: {
  gitCommit?: string;
  nodeVersion: string;
  load: system.LoadMetrics;
  collectedAt: number;
}): util.Child {
  const sampleAttrs = buildLocalizedTitle([{prefix: 'Sampled ', epoch: info.collectedAt}]);
  return (
    <span className='sys-meta muted' {...sampleAttrs}>
      {info.gitCommit && (
        <>
          <a
            href={`${REPO_COMMIT_URL}${encodeURIComponent(info.gitCommit)}`}
            target='_blank'
            rel='noopener noreferrer'
            className='subtle'
            title={`Deployed commit ${info.gitCommit}`}
          >
            {info.gitCommit}
          </a>
          {' · '}
        </>
      )}
      {info.nodeVersion} · proc {formatUptime(info.load.processUptimeSeconds)}
    </span>
  );
}

function renderLoadRow(load: system.LoadMetrics): util.Child {
  const loadClass = load.load1 > load.cpus * 1.5
    ? 'no'
    : load.load1 > load.cpus ? 'warn' : undefined;
  return (
    <>
      <span className={loadClass}>
        {load.load1.toFixed(2)} / {load.load5.toFixed(2)} / {load.load15.toFixed(2)}
      </span>{' '}
      <span className='muted'>
        ({load.cpus} cores · up {formatUptime(load.uptimeSeconds)})
      </span>
    </>
  );
}

interface SystemCardExtras {
  pendingQueue: number;
  unsentDms: number;
}

function renderSystemCards(
  sys: AdminSystemSnapshot,
  now: number,
  extras: SystemCardExtras
): util.Html {
  const {vps, arena: arenaSys, lastHeartbeatAt} = sys;
  const vpsSampleAttrs = buildLocalizedTitle([{prefix: 'Sampled ', epoch: vps.collectedAt}]);
  const arenaSampleAttrs = arenaSys
    ? buildLocalizedTitle([{prefix: 'Sampled ', epoch: arenaSys.collectedAt}])
    : {};

  const vpsNetErrs = (vps.network.rxErrors ?? 0) + (vps.network.txErrors ?? 0);
  const tlsClass = vps.tlsCert
    ? (vps.tlsCert.daysRemaining < TLS_CRIT_DAYS
      ? 'no'
      : vps.tlsCert.daysRemaining < TLS_WARN_DAYS ? 'warn' : 'muted')
    : 'muted';
  const tlsTitleAttrs = vps.tlsCert
    ? buildLocalizedTitle([
      {prefix: 'Expires ', epoch: vps.tlsCert.expiresAt},
      ...(vps.tlsCert.checkedAt !== undefined
        ? [{prefix: 'Checked ', epoch: vps.tlsCert.checkedAt}]
        : []),
    ])
    : {};

  const totalSse = vps.traffic.sse.battles + vps.traffic.sse.tournaments + vps.traffic.sse.admin;
  const p95Class = vps.traffic.p95LatencyMillis !== undefined
    ? (vps.traffic.p95LatencyMillis > P95_CRIT_MILLIS
      ? 'no'
      : vps.traffic.p95LatencyMillis > P95_WARN_MILLIS ? 'warn' : undefined)
    : undefined;

  const err5xxClass = vps.traffic.errors5xx1h > 0 ? 'no' : 'muted';
  const rateLimitWarn = vps.traffic.rateLimited4291h >= RATE_LIMIT_WARN_COUNT;
  const dmWarn = extras.unsentDms > 0;
  const last5xxTitleAttrs = vps.traffic.last5xx
    ? buildLocalizedTitle([
      `Last: ${vps.traffic.last5xx.status} ${vps.traffic.last5xx.path}`,
      {prefix: 'at ', epoch: vps.traffic.last5xx.at},
    ])
    : {};

  const hbStale = lastHeartbeatAt === undefined || now - lastHeartbeatAt > HEARTBEAT_STALE_SECONDS;
  const hbTitleAttrs = lastHeartbeatAt !== undefined
    ? buildLocalizedTitle([{prefix: 'Last heartbeat ', epoch: lastHeartbeatAt}])
    : {};
  const faultRatePct = vps.arenaFaults24h.matches > 0
    ? (vps.arenaFaults24h.faults / vps.arenaFaults24h.matches) * 100
    : 0;
  const faultClass = faultRatePct > FAULT_RATE_CRIT_PCT
    ? 'no'
    : faultRatePct > FAULT_RATE_WARN_PCT ? 'warn' : 'muted';
  const arenaNetErrs = arenaSys
    ? (arenaSys.network.rxErrors ?? 0) + (arenaSys.network.txErrors ?? 0)
    : 0;
  const gcsStale = Boolean(
    arenaSys && (
      arenaSys.backups.lastArchiveUploadAt === undefined ||
      now - arenaSys.backups.lastArchiveUploadAt > ARCHIVE_STALE_SECONDS
    )
  );

  return (
    <>
      <div className='sys-card'>
        <div className='sys-head'>
          <span className='sys-title'>pkmn.ai</span>
          {renderHostMeta(vps)}
        </div>
        <dl className='sys-dl'>
          <dt>Load</dt>
          <dd {...vpsSampleAttrs}>{renderLoadRow(vps.load)}</dd>

          <dt>Memory</dt>
          <dd {...vpsSampleAttrs}>{renderMemoryRow(vps.memory)}</dd>

          <dt>Disk</dt>
          <dd {...vpsSampleAttrs}>
            {vps.disks.map(renderDiskRow)}
            <span className='sys-line muted'>
              SQLite {formatBytes(vps.database.dbBytes)}
              {vps.database.walBytes > 0 ? ` (+${formatBytes(vps.database.walBytes)} WAL)` : ''}
            </span>
          </dd>

          <dt>Network</dt>
          <dd>
            <span className='sys-line'>
              Internal: {renderProbeBadge(vps.network.internal, 'idle', INTERNAL_RTT_WARN_MILLIS)}
              {' · '}
              External: {renderProbeBadge(
                vps.network.external,
                'pending',
                EXTERNAL_RTT_WARN_MILLIS
              )}
              {vps.tlsCert && (
                <>
                  {' · '}
                  <span className={tlsClass} {...tlsTitleAttrs}>
                    TLS {vps.tlsCert.daysRemaining}d
                  </span>
                </>
              )}
            </span>
            {vps.network.iface && (
              <span className='sys-line muted'>
                {vps.network.iface}
                {vps.network.rxBytesPerSec !== undefined &&
                  vps.network.txBytesPerSec !== undefined &&
                  ` ↓${formatRate(vps.network.rxBytesPerSec)} ` +
                  `↑${formatRate(vps.network.txBytesPerSec)}`}
                {' · '}
                <span className={vpsNetErrs > 0 ? 'warn' : undefined}>{vpsNetErrs} err</span>
              </span>
            )}
          </dd>

          <dt>Traffic</dt>
          <dd>
            <span className='sys-line'>
              <strong>{vps.traffic.activeVisitors5m}</strong> active (5m) ·{' '}
              <strong>{totalSse}</strong> SSE{' '}
              <span className='muted'>
                ({vps.traffic.sse.battles} battles, {vps.traffic.sse.tournaments} tourney)
              </span>
            </span>
            <span className='sys-line muted'>
              {vps.traffic.requests1m} req/m ({vps.traffic.requests1h.toLocaleString('en-US')}/1h)
              {vps.traffic.meanLatencyMillis !== undefined && (
                <>
                  {' · '}{vps.traffic.meanLatencyMillis}ms avg
                  {vps.traffic.p95LatencyMillis !== undefined && (
                    <>
                      {' ('}
                      <span className={p95Class}>{vps.traffic.p95LatencyMillis}ms p95</span>
                      {')'}
                    </>
                  )}
                </>
              )}
            </span>
          </dd>

          <dt>Errors</dt>
          <dd>
            <span className={err5xxClass} {...last5xxTitleAttrs}>
              {vps.traffic.errors5xx1h} 5xx
            </span>
            {' · '}
            <span className='muted'>
              {vps.traffic.errors4xx1h} 4xx
              {vps.traffic.rateLimited4291h > 0 && (
                <>
                  {' ('}
                  <span className={rateLimitWarn ? 'warn' : undefined}>
                    {vps.traffic.rateLimited4291h} 429
                  </span>
                  {')'}
                </>
              )}
            </span>
            {' · '}
            <span
              className={dmWarn ? 'warn' : 'muted'}
              title={
                'Undelivered smoke/quarantine Discord DMs awaiting next 60s sync ' +
                'or owner Discord link'
              }
            >
              {extras.unsentDms} unsent DMs
            </span>
          </dd>

          <dt>Backups</dt>
          <dd {...buildBackupTooltip(vps.backups)}>{renderBackupDbPart(vps.backups, now)}</dd>

          <dt>Updates</dt>
          <dd>{renderUpdatesRow(vps.updates)}</dd>
        </dl>
      </div>

      <div className='sys-card'>
        <div className='sys-head'>
          <span className='sys-title'>Arena</span>
          {arenaSys ? (
            renderHostMeta(arenaSys)
          ) : (
            <span className='sys-meta muted'>No heartbeat yet</span>
          )}
        </div>
        {!arenaSys ? (
          <p className='muted' style={{margin: '0.25rem 0', fontSize: '0.88em'}}>
            Waiting for Arena host telemetry on the next heartbeat.
          </p>
        ) : (
          <dl className='sys-dl'>
            <dt>Load</dt>
            <dd {...arenaSampleAttrs}>{renderLoadRow(arenaSys.load)}</dd>

            <dt>Memory</dt>
            <dd {...arenaSampleAttrs}>{renderMemoryRow(arenaSys.memory)}</dd>

            <dt>Disk</dt>
            <dd {...arenaSampleAttrs}>
              {arenaSys.disks.map(renderDiskRow)}
              {arenaSys.database && (
                <span className='sys-line muted'>
                  SQLite {formatBytes(arenaSys.database.dbBytes)}
                  {arenaSys.database.walBytes > 0
                    ? ` (+${formatBytes(arenaSys.database.walBytes)} WAL)`
                    : ''}
                </span>
              )}
            </dd>

            <dt>Network</dt>
            <dd>
              <span className='sys-line'>
                Internal:{' '}
                {renderProbeBadge(arenaSys.network.internal, 'idle', INTERNAL_RTT_WARN_MILLIS)}
                {' · '}
                External:{' '}
                {renderProbeBadge(arenaSys.network.external, 'pending', EXTERNAL_RTT_WARN_MILLIS)}
              </span>
              {arenaSys.network.iface && (
                <span className='sys-line muted'>
                  {arenaSys.network.iface}
                  {arenaSys.network.rxBytesPerSec !== undefined &&
                    arenaSys.network.txBytesPerSec !== undefined &&
                    ` ↓${formatRate(arenaSys.network.rxBytesPerSec)} ` +
                    `↑${formatRate(arenaSys.network.txBytesPerSec)}`}
                  {' · '}
                  <span className={arenaNetErrs > 0 ? 'warn' : undefined}>{arenaNetErrs} err</span>
                </span>
              )}
            </dd>

            <dt>Runtime</dt>
            <dd>
              <span className='sys-line'>
                Heartbeat{' '}
                {lastHeartbeatAt !== undefined ? (
                  <span
                    id='admin-hb-age'
                    className={hbStale ? 'no' : 'yes'}
                    {...hbTitleAttrs}
                  >
                    {formatAge(now - lastHeartbeatAt)} ago
                  </span>
                ) : (
                  <span className='no'>none</span>
                )}
                {arenaSys.podmanState && (
                  <>
                    {' · '}
                    <span
                      className={arenaSys.podmanState === 'running' ? 'yes' : 'warn'}
                      {...(arenaSys.podmanCheckedAt !== undefined
                        ? buildLocalizedTitle([
                          {prefix: 'Checked ', epoch: arenaSys.podmanCheckedAt},
                        ])
                        : {})}
                    >
                      Podman {arenaSys.podmanState}
                    </span>
                  </>
                )}
              </span>
              <span className='sys-line'>
                <span
                  className={extras.pendingQueue > 0 ? 'warn' : 'muted'}
                  title='Submitted versions waiting for Arena smoke testing'
                >
                  Queue {extras.pendingQueue} pending
                </span>
                {' · '}
                <span
                  className={arenaSys.outboxPending > 0 ? 'warn' : 'muted'}
                  title='Completed match/smoke payloads buffered on Arena awaiting VPS flush'
                >
                  Outbox {arenaSys.outboxPending}
                </span>
              </span>
            </dd>

            <dt>Errors</dt>
            <dd>
              <span className={arenaSys.daemonErrors > 0 ? 'no' : 'muted'}>
                {arenaSys.daemonErrors} daemon err
              </span>
              {' · '}
              <span className={faultClass}>
                24h faults {vps.arenaFaults24h.faults}/{vps.arenaFaults24h.matches} (
                {faultRatePct.toFixed(1)}%)
              </span>
            </dd>

            <dt>Backups</dt>
            <dd {...buildBackupTooltip(arenaSys.backups)}>
              {renderBackupDbPart(arenaSys.backups, now)}
              {' · '}
              {arenaSys.backups.lastArchiveUploadAt !== undefined ? (
                <span className={gcsStale ? 'warn' : 'yes'}>
                  GCS {formatAge(now - arenaSys.backups.lastArchiveUploadAt)} ago
                </span>
              ) : (
                <span className='warn'>GCS none</span>
              )}
              {arenaSys.backups.archiveError && (
                <span className='sys-line no'>{arenaSys.backups.archiveError}</span>
              )}
            </dd>

            <dt>Updates</dt>
            <dd>{renderUpdatesRow(arenaSys.updates)}</dd>
          </dl>
        )}
      </div>
    </>
  );
}

function renderSystemSection(
  sys: AdminSystemSnapshot,
  now: number,
  extras: SystemCardExtras
): util.Child {
  return (
    <section id='system'>
      <h3><a href='#system' className='subtle'>System</a></h3>
      <div
        id='system-cards'
        className='sys-grid'
        data-generated-at={String(now)}
        data-heartbeat-at={sys.lastHeartbeatAt !== undefined ? String(sys.lastHeartbeatAt) : ''}
      >
        {renderSystemCards(sys, now, extras)}
      </div>
    </section>
  );
}

function computeRunnerHealth(arenaHandle: arena.Handle | undefined, now: number): RunnerHealth {
  if (!arenaHandle) return {status: 'idle'};
  const state = arenaHandle.getState();
  const live = state.live;
  const liveMatch = live
    ? {
      ladderId: live.ladderId,
      p1: `${live.p1.name} ${live.p1.version}`,
      p2: `${live.p2.name} ${live.p2.version}`,
    }
    : undefined;
  if (state.watchdogTriggered || state.stale) {
    return {status: 'stale', lastContactAt: state.lastContactAt, liveMatch};
  }
  if (state.lastContactAt !== undefined) {
    const staleByAge = now - state.lastContactAt > 15 * 60;
    return {
      status: staleByAge ? 'stale' : 'online',
      lastContactAt: state.lastContactAt,
      liveMatch,
    };
  }
  return {status: liveMatch ? 'online' : 'idle', liveMatch};
}

export function buildAdminSnapshot(
  database: db.Database,
  adminLogin: string,
  arenaHandle?: arena.Handle,
  now = Math.floor(Date.now() / 1000),
  systemSnapshot?: AdminSystemSnapshot
): AdminSnapshot {
  const currentLadders = database.getCurrentLadders();
  const ladderSummaries = database.getLadderAdminSummaries(now);
  const ladders: AdminLadderItem[] = currentLadders.map(ladder => ({
    ladder,
    summary: ladderSummaries.get(ladder.id) ?? {
      ladderId: ladder.id,
      activeAgents: 0,
      activeEntries: 0,
      unsettledEntries: 0,
      quarantinedEntries: 0,
      totalMatches: 0,
      matches24h: 0,
      harvestedTeams: 0,
      lockedPools: 0,
      savedPools: 0,
    },
  }));

  const allAgents = database.getAllAgents();
  const devsByAgent = database.getDevelopersByAgent();
  const laddersByAgent = database.getAgentLaddersByAgent();
  const entriesByAgent = database.getAdminEntriesByAgent();
  const poolsByAgent = database.getTeamPoolCountsByAgent();
  const tourneysByAgent = database.getTournamentEntrantsByAgent();
  const poolLadders = currentLadders.filter(l => l.team === 'pools' && l.teams);

  const agents: AdminAgentItem[] = allAgents.map(agent => {
    const agentPools = poolsByAgent.get(agent.id);
    const pools: AdminPoolProgress[] = [];
    for (const pl of poolLadders) {
      const counts = agentPools?.get(pl.id);
      if (counts && (counts.saved > 0 || counts.pending > 0 || counts.active > 0)) {
        pools.push({
          ladderId: pl.id,
          ladderName: pl.name,
          required: pl.teams!,
          saved: counts.saved,
          pending: counts.pending,
          active: counts.active,
        });
      }
    }
    return {
      agent,
      developers: devsByAgent.get(agent.id) ?? [],
      qualifiedLadders: laddersByAgent.get(agent.id) ?? [],
      submissionStatus: database.computeAgentSubmissionStatus(agent.id, now),
      pools,
      tournaments: tourneysByAgent.get(agent.id) ?? [],
      entries: entriesByAgent.get(agent.id) ?? [],
      versions: database.getVersionsForAgent(agent.id),
    };
  });

  const pendingSubmissions: AdminPendingItem[] = database.getPendingSubmissions().map(p => {
    const ver = database.getVersionById(p.versionId);
    return {
      versionId: p.versionId,
      agentSlug: p.agentSlug,
      agentName: p.agentName,
      version: p.version,
      ladders: p.ladders,
      tournaments: p.tournaments,
      submittedAt: ver?.submittedAt ?? now,
    };
  });

  const fallbackMonitor = systemSnapshot
    ? undefined
    : new system.VpsHostMonitor({dbPath: database.dbPath, now: () => now});
  const arenaState = arenaHandle?.getState();
  const sys: AdminSystemSnapshot = systemSnapshot ?? {
    vps: fallbackMonitor!.sampleNow({
      sse: {
        battles: arenaState?.sseViewers.battles ?? 0,
        tournaments: arenaState?.sseViewers.tournaments ?? 0,
        admin: 0,
      },
      arenaFaults24h: database.getRecentFaultSummary(now),
      lastHeartbeatAt: arenaState?.lastHeartbeatAt,
    }),
    ...(arenaState?.arenaSystem ? {arena: arenaState.arenaSystem} : {}),
    ...(arenaState?.lastHeartbeatAt !== undefined
      ? {lastHeartbeatAt: arenaState.lastHeartbeatAt}
      : {}),
  };

  return {
    generatedAt: now,
    admin: adminLogin,
    system: sys,
    health: {
      runner: computeRunnerHealth(arenaHandle, now),
      pendingSubmissions,
      unsentDmCount: database.getPendingVersionDms().length,
      discordMemberCount: database.countDiscordMembers(),
    },
    ladders,
    agents,
  };
}

function renderLaddersSection(ladders: AdminLadderItem[]): util.Child {
  return (
    <section id='ladders'>
      <h3><a href='#ladders' className='subtle'>Ladders</a></h3>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Ladder</th>
              <th>Status</th>
              <th>Sim</th>
              <th className='num' title='Settled / total active entries'>Entrants</th>
              <th>Anchor</th>
              <th className='num' title='Matches completed in last 24h / all-time'>Matches</th>
            </tr>
          </thead>
          <tbody>
            {ladders.map(({ladder, summary}) => {
              const statusClass = ladder.status === 'active'
                ? 'yes'
                : ladder.status === 'settling' ? 'warn' : 'muted';
              const total = summary.activeEntries;
              const settled = Math.max(0, total - summary.unsettledEntries);
              const anchorHref = summary.anchor
                ? `/projects/${encodeURIComponent(summary.anchor.agentSlug)}/` +
                  `?v=${encodeURIComponent(summary.anchor.version)}` +
                  `#${encodeURIComponent(ladder.slot)}`
                : undefined;
              return (
                <tr>
                  <td title={`${ladder.id} · ${ladder.format}`}>
                    <a
                      href={`/arena/ladders/${encodeURIComponent(ladder.slot)}/`}
                      className='subtle'
                    >
                      <strong>{ladder.name}</strong>
                    </a>
                  </td>
                  <td><span className={statusClass}>{ladder.status}</span></td>
                  <td title={ladder.format}>
                    <tt>{ladder.version}</tt>
                  </td>
                  <td
                    className='num'
                    title={
                      `${settled} settled of ${total} active entries ` +
                      `(min ${ladder.min} projects)`
                    }
                  >
                    {settled}/{total}
                  </td>
                  <td>
                    {summary.anchor && anchorHref ? (
                      <a href={anchorHref} className='subtle'>
                        {summary.anchor.agentName} <code>{summary.anchor.version}</code>
                      </a>
                    ) : (
                      <span className='muted'>—</span>
                    )}
                  </td>
                  <td className='num'>
                    {summary.matches24h.toLocaleString('en-US')}/
                    {summary.totalMatches.toLocaleString('en-US')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatPoolProgress(p: AdminPoolProgress): string {
  if (p.active >= p.required) return `${p.ladderName}: ${p.active}/${p.required} teams`;
  if (p.pending > 0) return `${p.ladderName}: ${p.pending}/${p.required} teams (pending)`;
  return `${p.ladderName}: ${p.saved}/${p.required} teams (saved)`;
}

function renderProjectDetailPanel(
  item: AdminAgentItem,
  ladderNameById: ReadonlyMap<string, string>
): util.Child {
  const {agent, entries, versions, pools, tournaments} = item;
  const activeMeta: util.Child[] = [];
  if (pools.length > 0) {
    activeMeta.push(
      <span><span className='muted'>Pools:</span> {pools.map(formatPoolProgress).join(', ')}</span>
    );
  }

  return (
    <div className='detail-panel'>
      {activeMeta.length > 0 && <div className='detail-meta'>{activeMeta}</div>}

      {entries.length > 0 && (
        <div>
          <h4>Ladders</h4>
          <div className='table-wrap'>
            <table className='sub-table'>
              <thead>
                <tr>
                  <th>Ladder</th>
                  <th>Version</th>
                  <th className='num'>Rating</th>
                  <th className='num'>Matches</th>
                  <th className='num'>Telemetry</th>
                  <th className='num'>Faults</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => {
                  const settled = e.settledAt !== undefined || (
                    e.se <= SETTLED_MAX_SE && e.matches >= SETTLED_MIN_MATCHES
                  );
                  const ci = e.isAnchor ? 0 : Math.round(1.96 * e.se);
                  const faults = formatFaultCounts(e.crashes, e.timeouts, e.ooms);
                  return (
                    <tr>
                      <td><strong>{e.ladderName}</strong></td>
                      <td>
                        <code>{e.version}</code>
                        {e.role === 'quarantined' && (
                          <> <span className='no'>(quarantined)</span></>
                        )}
                        {e.isAnchor && <> <span className='muted'>(anchor)</span></>}
                      </td>
                      <td className='num'>
                        <strong>{Math.round(e.elo)}</strong>{' '}
                        <span className='muted'>±{ci}</span>
                      </td>
                      <td className='num'>
                        {e.matches}{' '}
                        <span className={settled ? 'muted' : 'warn'}>
                          ({settled ? 'settled' : `SE ${e.se.toFixed(0)}`})
                        </span>
                      </td>
                      <td className='num'>
                        {Math.round(e.meanTurnMillis)}ms · {Math.round(e.peakRam)} MiB
                      </td>
                      <td className='num'>
                        {faults.length > 0 ? (
                          <span className='no'>{faults.join(', ')}</span>
                        ) : (
                          <span className='muted'>—</span>
                        )}
                      </td>
                      <td>
                        <span className='action-group'>
                          {e.role === 'quarantined' ? (
                            <button
                              type='button'
                              className='btn-sm'
                              data-action='unquarantine'
                              data-agent={agent.slug}
                              data-version={e.version}
                            >
                              Unquarantine
                            </button>
                          ) : (
                            <>
                              <button
                                type='button'
                                className='btn-sm btn-danger'
                                data-action='retire'
                                data-ladder={e.ladderId}
                                data-agent={agent.slug}
                                data-version={e.version}
                                disabled={e.isAnchor}
                                title={
                                  e.isAnchor
                                    ? 'Assign a new 1500 Elo anchor before retiring'
                                    : `Retire ${e.version} on ${e.ladderName}`
                                }
                              >
                                Retire
                              </button>
                              <button
                                type='button'
                                className='btn-sm btn-danger'
                                data-action='quarantine'
                                data-agent={agent.slug}
                                data-version={e.version}
                              >
                                Quarantine
                              </button>
                            </>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tournaments.length > 0 && (
        <div>
          <h4>Tournaments</h4>
          <div className='table-wrap'>
            <table className='sub-table'>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Name</th>
                  <th>Version</th>
                  <th className='num'>Rating</th>
                  <th className='num'>Record</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {tournaments.map(t => {
                  const games = t.gameWins + t.gameLosses + t.gameTies;
                  const record = `${t.gameWins}-${t.gameLosses}` +
                    (t.gameTies > 0 ? `-${t.gameTies}` : '');
                  const statusClass = t.tournamentStatus === 'running' ? 'yes' : 'muted';
                  return (
                    <tr>
                      <td className='muted'>
                        <time
                          data-epoch={String(t.startsAt)}
                          data-fmt='date'
                          {...buildLocalizedTitle([{prefix: 'Starts ', epoch: t.startsAt}])}
                        >
                          {util.formatUtcDate(t.startsAt)}
                        </time>
                      </td>
                      <td>
                        <a
                          href={`/arena/tournaments/${encodeURIComponent(t.tournamentId)}/`}
                          className='subtle'
                        >
                          <strong>{formatTournamentName(t.tournamentName)}</strong>
                        </a>
                      </td>
                      <td><code>{t.version}</code></td>
                      <td className='num'>
                        {games > 0 ? (
                          <>
                            <strong>{Math.round(t.elo)}</strong>{' '}
                            <span className='muted'>±{Math.round(1.96 * t.se)}</span>
                          </>
                        ) : (
                          <span className='muted'>—</span>
                        )}
                      </td>
                      <td className='num'>
                        {games > 0 ? record : <span className='muted'>—</span>}
                      </td>
                      <td>
                        {t.finalRank !== undefined ? (
                          <>
                            <strong>#{t.finalRank}</strong>{' '}
                            <span className='muted'>({t.tournamentStatus})</span>
                          </>
                        ) : (
                          <span className={statusClass}>{t.tournamentStatus}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div>
        <h4>History ({versions.length})</h4>
        {versions.length === 0 ? (
          <p className='muted'>No versions submitted yet.</p>
        ) : (
          <div className='table-wrap'>
            <table className='sub-table'>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Targets</th>
                  <th>Smoke</th>
                  <th>State</th>
                  <th className='num'>Submitted</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {versions.slice(0, 15).map(v => {
                  const targets = [
                    ...v.ladders.map(id => ladderNameById.get(id) ?? id),
                    ...(v.tournamentNames ?? []).map(formatTournamentName),
                  ];
                  // TODO(bot_debug_diagnostic_matches): surface smoke logs, replay link,
                  // diagnostics, and full stderr for each version once rebased.
                  let smokeEl: util.Child;
                  if (v.smokeStatus === 'pending') {
                    smokeEl = <span className='warn'>PENDING</span>;
                  } else if (v.smokeStatus === 'passed') {
                    smokeEl = <span className='yes'>PASS</span>;
                  } else {
                    smokeEl = (
                      <>
                        <span className='no'>
                          {v.smokeStatus === 'quarantined' ? 'QUARANTINED' : 'FAIL'}
                        </span>{' '}
                        <span className={v.notified ? 'muted' : 'warn'}>
                          ({v.notified ? 'DM sent' : 'DM unsent'})
                        </span>
                        {v.smokeError && (
                          <details className='smoke-log'>
                            <summary>stderr</summary>
                            <pre><code>{v.smokeError}</code></pre>
                          </details>
                        )}
                      </>
                    );
                  }
                  const stateText = v.smokeStatus === 'pending'
                    ? 'Pending'
                    : v.smokeStatus === 'failed'
                      ? 'Rejected'
                      : v.smokeStatus === 'quarantined'
                        ? 'Quarantined'
                        : v.activeLadderNames.length > 0
                          ? `Active (${v.activeLadderNames.join(', ')})`
                          : (v.tournamentNames?.length ?? 0) > 0 && v.ladders.length === 0
                            ? 'Entered'
                            : 'Retired';
                  return (
                    <tr>
                      <td><code>{v.version}</code></td>
                      <td className='wrap'><tt>{targets.join(', ') || '—'}</tt></td>
                      <td className='wrap'>{smokeEl}</td>
                      <td>{stateText}</td>
                      <td className='num muted'>
                        <time
                          data-epoch={String(v.submittedAt)}
                          data-fmt='date'
                          {...buildLocalizedTitle([{prefix: 'Submitted ', epoch: v.submittedAt}])}
                        >
                          {util.formatUtcDate(v.submittedAt)}
                        </time>
                      </td>
                      <td>
                        <span className='action-group'>
                          {v.smokeStatus === 'passed' && (
                            <button
                              type='button'
                              className='btn-sm btn-danger'
                              data-action='quarantine'
                              data-agent={agent.slug}
                              data-version={v.version}
                            >
                              Quarantine
                            </button>
                          )}
                          {v.smokeStatus === 'quarantined' && v.activatedAt !== undefined && (
                            <button
                              type='button'
                              className='btn-sm'
                              data-action='unquarantine'
                              data-agent={agent.slug}
                              data-version={v.version}
                            >
                              Unquarantine
                            </button>
                          )}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function renderAdminPage(opts: {
  snapshot: AdminSnapshot;
  allLadders: db.LadderRow[];
  liveTournament?: {id: string; name: string};
}): string {
  const {snapshot, allLadders, liveTournament} = opts;
  const ladderNameById = new Map(allLadders.map(l => [l.id, l.name]));
  const {pendingSubmissions, unsentDmCount} = snapshot.health;

  const content = (
    <>
      <div id='admin-feedback' className='admin-feedback hide' role='status' />

      {renderSystemSection(snapshot.system, snapshot.generatedAt, {
        pendingQueue: pendingSubmissions.length,
        unsentDms: unsentDmCount,
      })}
      {renderLaddersSection(snapshot.ladders)}

      <section id='projects'>
        <h3><a href='#projects' className='subtle'>Projects ({snapshot.agents.length})</a></h3>
        {snapshot.agents.length === 0 ? (
          <p className='muted'>No Arena projects registered yet.</p>
        ) : (
          <div className='table-wrap'>
            <table>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Discord</th>
                  <th>Ladders</th>
                  <th>Eligibility</th>
                  <th>Entered</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.agents.map(item => {
                  const {agent, developers, qualifiedLadders, submissionStatus} = item;
                  const qualifiedSet = new Set(qualifiedLadders);
                  const isDisabled = agent.status === 'disabled';
                  const statusClass = submissionStatus.label === 'Eligible'
                    ? 'yes'
                    : submissionStatus.label === 'Ineligible' ? 'no' : 'muted';
                  const hasCooldown = submissionStatus.nextEligibleAt !== undefined;
                  const activeEntries = item.entries.filter(e => e.role !== 'quarantined');
                  const quarantinedEntries = item.entries.filter(e => e.role === 'quarantined');
                  const linkedDiscord = developers.filter(
                    d => Boolean(d.discordId && d.discordUsername)
                  );
                  const badSmogon = developers.find(
                    d => d.smogonStanding === 'bad' || d.smogonStanding === 'missing'
                  );
                  const conciseReason = formatAdminReason(submissionStatus.reason);

                  return (
                    <>
                      <tr
                        className={isDisabled ? 'project-row secondary' : 'project-row'}
                        data-agent-row={agent.slug}
                        tabIndex={0}
                        aria-expanded='false'
                      >
                        <td>
                          <span className='row-toggle' aria-hidden='true'>{'\u25b8'}</span>
                          <a
                            href={`/projects/${encodeURIComponent(agent.slug)}/`}
                            className='subtle'
                          >
                            <strong>{agent.name}</strong>
                          </a>
                          {isDisabled && <> <span className='muted'>(disabled)</span></>}
                          {badSmogon && (
                            <>
                              {' '}
                              <span
                                className='no'
                                title={
                                  `${badSmogon.githubLogin} / ${badSmogon.smogonUsername}: ` +
                                  `Smogon ${badSmogon.smogonStanding}`
                                }
                              >
                                (Smogon {badSmogon.smogonStanding})
                              </span>
                            </>
                          )}
                        </td>
                        <td className='wrap'>
                          {linkedDiscord.length === 0 ? (
                            <span
                              className='muted'
                              title={
                                developers.length > 0
                                  ? 'No Discord linked ' +
                                    `(${developers.map(d => d.githubLogin).join(', ')})`
                                  : 'Unowned'
                              }
                            >
                              —
                            </span>
                          ) : (
                            <div className='discord-list'>
                              {linkedDiscord.map(dev => (
                                <a
                                  href={`https://discord.com/users/${encodeURIComponent(dev.discordId!)}`}
                                  target='_blank'
                                  rel='noopener noreferrer'
                                  title={
                                    `DM @${dev.discordUsername} on Discord · ` +
                                    `GitHub: ${dev.githubLogin} · ` +
                                    `Smogon: ${dev.smogonUsername} (${dev.smogonStanding})`
                                  }
                                >
                                  @{dev.discordUsername}
                                </a>
                              ))}
                            </div>
                          )}
                        </td>
                        <td>
                          <div className='ladder-checks'>
                            {ALL_SLOTS.map(slot => (
                              <label className={isDisabled ? 'disabled' : undefined}>
                                <input
                                  type='checkbox'
                                  className='ladder-toggle'
                                  data-agent={agent.slug}
                                  data-slot={slot}
                                  checked={qualifiedSet.has(slot)}
                                  disabled={isDisabled}
                                />
                                {SLOT_LABELS[slot]}
                              </label>
                            ))}
                          </div>
                        </td>
                        <td className='wrap'>
                          <div className='status-cell'>
                            <div className='status-head'>
                              <span className={`status-label ${statusClass}`}>
                                {submissionStatus.label}
                              </span>
                              {hasCooldown && (
                                <button
                                  type='button'
                                  className='btn-sm'
                                  data-action='refund'
                                  data-agent={agent.slug}
                                >
                                  Refund
                                </button>
                              )}
                            </div>
                            <span
                              className={
                                conciseReason
                                  ? 'muted status-reason'
                                  : 'muted status-reason hide'
                              }
                              title={submissionStatus.reason ?? undefined}
                            >
                              {conciseReason}
                            </span>
                            {item.pools.map(p => (
                              <span className='muted status-reason'>
                                {formatPoolProgress(p)}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className='wrap'>
                          {activeEntries.length === 0 &&
                            quarantinedEntries.length === 0 &&
                            item.tournaments.length === 0 ? (
                              <span className='muted'>—</span>
                            ) : (
                              <div className='chip-list'>
                                {activeEntries.map(e => {
                                  const faults = formatFaultCounts(
                                    e.crashes,
                                    e.timeouts,
                                    e.ooms
                                  );
                                  const tip = faults.length > 0
                                    ? `${e.ladderName} ${e.version} ` +
                                      `(${e.matches} matches · ${faults.join(', ')})`
                                    : `${e.ladderName} ${e.version} (${e.matches} matches)`;
                                  return (
                                    <span
                                      className={faults.length > 0 ? 'chip chip-warn' : 'chip'}
                                      title={tip}
                                    >
                                      {e.ladderName} {e.version}
                                    </span>
                                  );
                                })}
                                {quarantinedEntries.map(e => (
                                  <span
                                    className='chip chip-bad'
                                    title={`Quarantined on ${e.ladderName}`}
                                  >
                                    {e.ladderName} {e.version} [Q]
                                  </span>
                                ))}
                                {item.tournaments.map(t => {
                                  const tName = formatTournamentName(t.tournamentName);
                                  return (
                                    <span
                                      className='chip'
                                      {...buildLocalizedTitle([
                                        `${tName} (${t.version})`,
                                        {epoch: t.startsAt},
                                      ])}
                                    >
                                      {tName}
                                    </span>
                                  );
                                })}
                              </div>
                            )}
                        </td>
                      </tr>
                      <tr className='detail-row hide' data-detail-for={agent.slug}>
                        <td colSpan={5}>
                          {renderProjectDetailPanel(item, ladderNameById)}
                        </td>
                      </tr>
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <script>{ADMIN_SCRIPT}</script>
    </>
  );

  return renderer.render({
    id: 'admin-page',
    title: 'Admin | pkmn.ai',
    header: injectLiveBanner(header('Admin'), liveTournament),
    path: '/admin/',
    style: STYLE,
    content,
  }, s => s.replace('</title>', '</title><meta name="robots" content="noindex">'));
}

export function register(app: polka.Polka, options: Options): Handle {
  util.installHeadSupport(app);
  const {db, auth, arena: arenaHandle} = options;
  const getNow = options.now ?? (() => Math.floor(Date.now() / 1000));
  const vpsMonitor = options.vpsMonitor ?? new system.VpsHostMonitor({
    dbPath: db.dbPath,
    now: getNow,
  });

  const adminStreamClients = new Set<http.ServerResponse>();
  let lastBroadcastMs = 0;
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | undefined;

  const keepaliveTimer = setInterval(() => {
    for (const client of adminStreamClients) {
      if (!client.writableEnded && !client.destroyed) {
        client.write(': keepalive\n\n');
      } else {
        adminStreamClients.delete(client);
      }
    }
  }, SSE_KEEPALIVE_MILLIS);
  keepaliveTimer.unref?.();

  const collectSystemSnapshot = (now: number): AdminSystemSnapshot => {
    const arenaState = arenaHandle?.getState();
    const vps = options.getVpsSystem
      ? options.getVpsSystem(now)
      : vpsMonitor.sampleNow({
        sse: {
          battles: arenaState?.sseViewers.battles ?? 0,
          tournaments: arenaState?.sseViewers.tournaments ?? 0,
          admin: adminStreamClients.size,
        },
        arenaFaults24h: db.getRecentFaultSummary(now),
        lastHeartbeatAt: arenaState?.lastHeartbeatAt,
      });
    return {
      vps,
      ...(arenaState?.arenaSystem ? {arena: arenaState.arenaSystem} : {}),
      ...(arenaState?.lastHeartbeatAt !== undefined
        ? {lastHeartbeatAt: arenaState.lastHeartbeatAt}
        : {}),
    };
  };

  const buildSystemEventPayload = (now: number) => {
    const sys = collectSystemSnapshot(now);
    const runner = computeRunnerHealth(arenaHandle, now);
    const pendingQueue = db.getPendingSubmissions().length;
    const unsentDms = db.getPendingVersionDms().length;
    return {
      generatedAt: now,
      ...(sys.lastHeartbeatAt !== undefined ? {lastHeartbeatAt: sys.lastHeartbeatAt} : {}),
      runner,
      vps: sys.vps,
      ...(sys.arena ? {arena: sys.arena} : {}),
      cardsHtml: renderSystemCards(sys, now, {pendingQueue, unsentDms}).toString(),
    };
  };

  const pushSystemEventNow = () => {
    if (adminStreamClients.size === 0) return;
    lastBroadcastMs = Date.now();
    const frame = `event: system\ndata: ${JSON.stringify(buildSystemEventPayload(getNow()))}\n\n`;
    for (const client of adminStreamClients) {
      if (client.writableEnded || client.destroyed) {
        adminStreamClients.delete(client);
        continue;
      }
      client.write(frame);
    }
  };

  const notifyHeartbeat = () => {
    if (adminStreamClients.size === 0) return;
    const elapsed = Date.now() - lastBroadcastMs;
    if (elapsed >= HEARTBEAT_PUSH_THROTTLE_MILLIS) {
      if (pendingBroadcastTimer) {
        clearTimeout(pendingBroadcastTimer);
        pendingBroadcastTimer = undefined;
      }
      pushSystemEventNow();
    } else if (!pendingBroadcastTimer) {
      pendingBroadcastTimer = setTimeout(() => {
        pendingBroadcastTimer = undefined;
        pushSystemEventNow();
      }, HEARTBEAT_PUSH_THROTTLE_MILLIS - elapsed);
      pendingBroadcastTimer.unref?.();
    }
  };

  const requireAdmin = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    wantsJson: boolean
  ): string | undefined => {
    const login = auth.getGitHubUser(req);
    if (!login) {
      if (wantsJson) {
        sendJson(res, 401, {error: 'GitHub authentication required.'});
      } else {
        redirect(res, '/auth/github?return_to=%2Fadmin%2F');
      }
      return undefined;
    }
    if (!isAdmin(login)) {
      if (wantsJson) {
        sendJson(res, 403, {error: 'Admin access required.'});
      } else {
        sendHtml(res, 403, renderErrorPage(403, db.getRunningTournament()));
      }
      return undefined;
    }
    return login;
  };

  const requireAdminMutation = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): string | undefined => {
    if (isCrossSiteRequest(req)) {
      sendJson(res, 403, {error: 'Cross-site requests are not allowed.'});
      return undefined;
    }
    return requireAdmin(req, res, true);
  };

  const handleGetAdmin = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    forceJson: boolean
  ) => {
    const wantsJson = forceJson || Boolean(req.headers.accept?.includes('application/json'));
    const login = requireAdmin(req, res, wantsJson);
    if (!login) return;

    const now = getNow();
    const sys = collectSystemSnapshot(now);
    const snapshot = buildAdminSnapshot(db, login, arenaHandle, now, sys);
    if (wantsJson) {
      sendJson(res, 200, {
        ...snapshot,
        agents: snapshot.agents.map(item => ({
          ...item,
          versions: item.versions.map(v => ({
            id: v.id,
            version: v.version,
            package: v.package,
            sha256: v.sha256,
            ladders: v.ladders,
            tournaments: v.tournaments,
            unpackedBytes: v.unpackedBytes,
            smokeStatus: v.smokeStatus,
            smokeError: v.smokeError,
            submittedAt: v.submittedAt,
            activatedAt: v.activatedAt,
            notified: v.notified,
            activeLadderNames: v.activeLadderNames,
            tournamentNames: v.tournamentNames,
          })),
        })),
      });
      return;
    }

    const html = renderAdminPage({
      snapshot,
      allLadders: db.getLadders(),
      liveTournament: db.getRunningTournament(),
    });
    sendHtml(res, 200, html);
  };

  app.get('/admin', (req, res) => handleGetAdmin(req, res, false));
  app.get('/admin.json', (req, res) => handleGetAdmin(req, res, true));
  app.get('/admin/index.json', (req, res) => handleGetAdmin(req, res, true));

  app.get('/api/admin/stream', (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    adminStreamClients.add(res);
    res.write(
      `event: system\ndata: ${JSON.stringify(buildSystemEventPayload(getNow()))}\n\n`
    );
    req.on('close', () => {
      adminStreamClients.delete(res);
    });
  });

  app.post('/api/admin/agents/:slug/ladders', async (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const slug = decodeParam(req.params.slug);
    let body: Record<string, unknown>;
    try {
      const raw = await util.readBody(req, MAX_ADMIN_BODY_BYTES, 'Admin payload too large.');
      body = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed JSON body.'});
      return;
    }

    const now = getNow();
    try {
      let result: db.SetAgentLaddersResult;
      if (Array.isArray(body.slots)) {
        result = db.setAgentLadders(slug, body.slots.map(String) as db.LadderSlot[], now);
      } else if (typeof body.slot === 'string' && typeof body.qualified === 'boolean') {
        result = db.setAgentLadder(slug, body.slot as db.LadderSlot, body.qualified, now);
      } else {
        sendJson(res, 400, {
          error: 'Expected {slot: string, qualified: boolean} or {slots: string[]}.',
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        agent: result.agent,
        qualifiedLadders: result.slots,
        submissionStatus: db.computeAgentSubmissionStatus(result.agent.id, now),
      });
    } catch (err: any) {
      const status = typeof err?.status === 'number'
        ? err.status
        : /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {error: err?.message || 'Failed updating ladder qualification.'});
    }
  });

  app.post('/api/admin/agents/:slug/refund-cooldown', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const slug = decodeParam(req.params.slug);
    const now = getNow();
    try {
      const agent = db.refundCooldown(slug, now);
      sendJson(res, 200, {
        ok: true,
        agent,
        submissionStatus: db.computeAgentSubmissionStatus(agent.id, now),
      });
    } catch (err: any) {
      const status = /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {error: err?.message || 'Failed refunding cooldown.'});
    }
  });

  app.post('/api/admin/versions/:slug/:version/quarantine', async (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const slug = decodeParam(req.params.slug);
    const version = decodeParam(req.params.version);
    let reason: string | undefined;
    try {
      const raw = await util.readBody(req, MAX_ADMIN_BODY_BYTES, 'Admin payload too large.');
      const parsed = (raw.trim() ? JSON.parse(raw) : {}) as Record<string, unknown>;
      if (typeof parsed.reason === 'string' && parsed.reason.trim()) {
        reason = parsed.reason.trim().slice(0, 500);
      }
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed JSON body.'});
      return;
    }

    const now = getNow();
    try {
      const result = db.quarantineVersion(slug, version, reason, now);
      sendJson(res, 200, {ok: true, version: result.version});
    } catch (err: any) {
      const status = typeof err?.status === 'number'
        ? err.status
        : /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {error: err?.message || 'Failed quarantining version.'});
    }
  });

  app.post('/api/admin/versions/:slug/:version/unquarantine', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const slug = decodeParam(req.params.slug);
    const version = decodeParam(req.params.version);
    const now = getNow();
    try {
      const updated = db.unquarantineVersion(slug, version, now);
      sendJson(res, 200, {ok: true, version: updated});
    } catch (err: any) {
      const status = typeof err?.status === 'number'
        ? err.status
        : /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {error: err?.message || 'Failed unquarantining version.'});
    }
  });

  app.post('/api/admin/ladders/:ladderId/entries/:slug/:version/retire', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const ladderId = decodeParam(req.params.ladderId);
    const slug = decodeParam(req.params.slug);
    const version = decodeParam(req.params.version);
    const now = getNow();
    try {
      db.retireLadderEntry(ladderId, slug, version, now);
      sendJson(res, 200, {ok: true});
    } catch (err: any) {
      const status = typeof err?.status === 'number'
        ? err.status
        : /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {error: err?.message || 'Failed retiring ladder entry.'});
    }
  });

  return {
    notifyHeartbeat,
    getAdminStreamCount: () => adminStreamClients.size,
    close: () => {
      clearInterval(keepaliveTimer);
      if (pendingBroadcastTimer) {
        clearTimeout(pendingBroadcastTimer);
        pendingBroadcastTimer = undefined;
      }
      for (const client of adminStreamClients) {
        if (!client.writableEnded && !client.destroyed) client.end();
      }
      adminStreamClients.clear();
    },
  };
}
