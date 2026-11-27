import * as fs from 'fs';
import * as http from 'http';

import polka from 'polka';

import {ALL_SLOTS, SETTLED_MAX_SE, SETTLED_MIN_MATCHES} from '../db';
import type * as db from '../db';
import {header, injectLiveBanner, renderErrorPage, renderer} from '../static/build';
import * as util from '../static/util';

import * as account from './account';
import * as arena from './arena';
import {Auth, isAdmin, isCrossSiteRequest} from './auth';
import type {AgentDiscordMember} from './discord';
import {AI_PANEL_STYLE} from './render';
import * as system from './system';
import {formatTournamentName} from './tournaments';
import * as wiki from './wiki';

export interface RegistrationIssue {
  number: number;
  title: string;
  url: string;
  author: string;
  authorUrl: string;
  createdAt: number;
  updatedAt: number;
  comments: number;
}

export interface RegistrationIssuesSnapshot {
  issues: RegistrationIssue[];
  checkedAt?: number;
  error?: string;
}

export interface RegistrationMonitorOptions {
  repo?: string;
  label?: string;
  token?: string;
  pollIntervalMillis?: number;
  fetchTimeoutMillis?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface Options {
  db: db.Database;
  auth: Auth;
  arena?: arena.Handle;
  wiki?: wiki.Wiki;
  publicDir?: string;
  vpsMonitor?: system.VpsHostMonitor;
  getVpsSystem?: (now: number) => system.VpsSystemInfo;
  registrationMonitor?: RegistrationIssueMonitor;
  getRegistrationIssues?: () => RegistrationIssuesSnapshot;
  getDiscordRoleMembers?: () => ReadonlyMap<number, AgentDiscordMember[]>;
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
  wipeable: boolean;
}

export interface AdminAgentItem {
  agent: db.AgentRow;
  developers: db.DeveloperRow[];
  discordRoleMembers: AgentDiscordMember[];
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
    stagedCount: number;
    unsentDmCount: number;
    discordMemberCount: number;
    smokeCadence: db.SmokeCadence;
  };
  ladders: AdminLadderItem[];
  matches24h: number;
  totalMatches: number;
  submissions: db.SubmissionAdminSummary;
  registrations: RegistrationIssuesSnapshot;
  agents: AdminAgentItem[];
  totalAgents: number;
  wipeableVersionIds: number[];
  wikiEdits: wiki.RecentEdit[];
  totalWikiEdits: number;
}

const MAX_ADMIN_BODY_BYTES = 16 * 1024;
const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;
const SSE_KEEPALIVE_MILLIS = 25_000;
const HEARTBEAT_PUSH_THROTTLE_MILLIS = 3000;
const REGISTRATION_REPO = 'pkmn/ai';
const REGISTRATION_LABEL = 'registration';
// Conditional `If-None-Match` (`304 Not Modified`) does not consume GitHub's 60 req/hr
// unauthenticated REST quota, so polling every 5 minutes keeps onboarding issues fresh for free.
const REGISTRATION_POLL_MILLIS = 5 * 60_000;
const REGISTRATION_FETCH_TIMEOUT_MILLIS = 10_000;
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

const STYLE =
  `${AI_PANEL_STYLE}\n${fs.readFileSync(util.root('static', 'style', 'admin.css'), 'utf8')}`;

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
      m = /^Version (\\S+) passed diagnostic testing; activate or discard/.exec(reason);
      if (m) return 'Staged ' + m[1] + ' awaiting activation.';
      if (reason === 'Project qualification is pending staff review.') {
        return 'Pending staff review.';
      }
      return reason;
    };

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

    ${util.UPDATE_TABLE_PAGER_SCRIPT}

    const projectsTbody = document.getElementById('projects-tbody');

    const toggleProjectRow = (row) => {
      const slug = row.dataset.agentRow;
      if (!slug || !projectsTbody) return;
      const detailRow = projectsTbody.querySelector('tr[data-detail-for="' + slug + '"]');
      if (!detailRow) return;
      const open = detailRow.classList.contains('hide');
      detailRow.classList.toggle('hide', !open);
      row.classList.toggle('expanded', open);
      row.setAttribute('aria-expanded', open ? 'true' : 'false');
    };

    if (projectsTbody) {
      const updateRowStatus = (row, slug, st) => {
        if (!row || !st) return;
        const labelEl = row.querySelector('.status-label');
        const reasonEl = row.querySelector('.status-reason');
        if (labelEl) {
          labelEl.textContent = st.label;
          labelEl.className = 'status-label ' + (
            st.label === 'Eligible' ? 'yes' : st.label === 'Ineligible' ? 'no' : 'muted'
          );
        }
        if (reasonEl) {
          const reasonText = pkmnTime.text(st.reason || '');
          reasonEl.textContent = formatAdminReason(reasonText);
          reasonEl.title = reasonText;
          reasonEl.classList.toggle('hide', !st.reason);
        }
        const head = row.querySelector('.status-head');
        if (head) {
          let refundBtn = head.querySelector('button[data-action="refund"]');
          if (st.nextEligibleAt !== undefined) {
            if (!refundBtn) {
              refundBtn = document.createElement('button');
              refundBtn.type = 'button';
              refundBtn.className = 'btn-sm';
              refundBtn.dataset.action = 'refund';
              refundBtn.dataset.agent = slug;
              refundBtn.textContent = 'Refund';
              const limitBtn = head.querySelector('button[data-action="smoke-limit"]');
              head.insertBefore(refundBtn, limitBtn || null);
            }
          } else if (refundBtn) {
            refundBtn.remove();
          }
        }
      };

      projectsTbody.addEventListener('change', async (ev) => {
        const cb = ev.target && ev.target.closest ? ev.target.closest('input.ladder-toggle') : null;
        if (!cb) return;
        const slug = cb.dataset.agent;
        const slot = cb.dataset.slot;
        const qualified = cb.checked;
        cb.disabled = true;
        try {
          const data = await postJson(
            '/api/admin/agents/' + encodeURIComponent(slug) + '/ladders',
            {slot, qualified}
          );
          updateRowStatus(cb.closest('tr'), slug, data.submissionStatus);
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

      projectsTbody.addEventListener('click', async (ev) => {
        const actionBtn = ev.target && ev.target.closest
          ? ev.target.closest('button[data-action]')
          : null;
        if (actionBtn) {
          const action = actionBtn.dataset.action;
          if (action === 'refund') {
            const slug = actionBtn.dataset.agent;
            actionBtn.disabled = true;
            try {
              await postJson(
                '/api/admin/agents/' + encodeURIComponent(slug) + '/refund-cooldown',
                {}
              );
              window.location.reload();
            } catch (err) {
              actionBtn.disabled = false;
              showFeedback(err.message || 'Failed refunding cooldown.', true);
            }
            return;
          }
          if (action === 'smoke-limit') {
            const slug = actionBtn.dataset.agent;
            const nextUnlimited = actionBtn.dataset.unlimited !== 'true';
            actionBtn.disabled = true;
            try {
              const data = await postJson(
                '/api/admin/agents/' + encodeURIComponent(slug) + '/smoke-limit',
                {unlimited: nextUnlimited}
              );
              const unlimited = Boolean(data.agent && data.agent.unlimitedSmokeTests);
              actionBtn.dataset.unlimited = unlimited ? 'true' : 'false';
              actionBtn.className = unlimited ? 'btn-sm btn-warn' : 'btn-sm';
              actionBtn.textContent = unlimited ? 'Unlimited' : 'Limited';
              actionBtn.title = unlimited
                ? 'Re-enable the 3-per-24h failed/discarded diagnostic rate limit'
                : 'Disable the 3-per-24h failed/discarded diagnostic rate limit';
              const row = actionBtn.closest('tr');
              if (row) {
                const noteEl = row.querySelector('.smoke-limit-note');
                if (noteEl) noteEl.classList.toggle('hide', !unlimited);
                updateRowStatus(row, slug, data.submissionStatus);
              }
              showFeedback(
                (unlimited ? 'Disabled ' : 'Re-enabled ') +
                  '3/24h diagnostic limit for ' + slug + '.',
                false
              );
            } catch (err) {
              showFeedback(err.message || 'Failed updating 3/24h diagnostic limit.', true);
            } finally {
              actionBtn.disabled = false;
            }
            return;
          }
          if (action === 'unquarantine') {
            const slug = actionBtn.dataset.agent;
            const version = actionBtn.dataset.version;
            actionBtn.disabled = true;
            try {
              await postJson(
                '/api/admin/versions/' + encodeURIComponent(slug) + '/' +
                  encodeURIComponent(version) + '/unquarantine',
                {}
              );
              window.location.reload();
            } catch (err) {
              actionBtn.disabled = false;
              showFeedback(err.message || 'Failed unquarantining version.', true);
            }
            return;
          }
          if (action === 'retire') {
            const group = actionBtn.closest('.action-group');
            if (!group || group.querySelector('.confirm-retire')) return;
            actionBtn.classList.add('hide');

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
              actionBtn.classList.remove('hide');
            };

            cancelBtn.addEventListener('click', cleanup);
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true;
              cancelBtn.disabled = true;
              try {
                await postJson(
                  '/api/admin/ladders/' + encodeURIComponent(actionBtn.dataset.ladder) +
                    '/entries/' + encodeURIComponent(actionBtn.dataset.agent) + '/' +
                    encodeURIComponent(actionBtn.dataset.version) + '/retire',
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
            return;
          }
          if (action === 'discard') {
            const group = actionBtn.closest('.action-group');
            if (!group || group.querySelector('.confirm-discard')) return;
            const siblings = Array.from(group.querySelectorAll('button'));
            siblings.forEach(b => b.classList.add('hide'));

            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'btn-sm btn-danger confirm-discard';
            confirmBtn.textContent = 'Confirm discard';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn-sm';
            cancelBtn.textContent = 'Cancel';

            const cleanup = () => {
              confirmBtn.remove();
              cancelBtn.remove();
              siblings.forEach(b => b.classList.remove('hide'));
            };

            cancelBtn.addEventListener('click', cleanup);
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true;
              cancelBtn.disabled = true;
              try {
                await postJson(
                  '/api/admin/versions/' + encodeURIComponent(actionBtn.dataset.versionId) +
                    '/discard',
                  {}
                );
                window.location.reload();
              } catch (err) {
                cleanup();
                showFeedback(err.message || 'Failed discarding staged version.', true);
              }
            });

            group.appendChild(confirmBtn);
            group.appendChild(cancelBtn);
            return;
          }
          if (action === 'wipe' || action === 'wipe-pool') {
            const group = actionBtn.closest('.action-group');
            if (!group || group.querySelector('.confirm-wipe')) return;
            const siblings = Array.from(group.querySelectorAll('button'));
            siblings.forEach(b => b.classList.add('hide'));

            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'btn-sm btn-danger confirm-wipe';
            confirmBtn.textContent = 'Confirm wipe';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'btn-sm';
            cancelBtn.textContent = 'Cancel';

            const cleanup = () => {
              confirmBtn.remove();
              cancelBtn.remove();
              siblings.forEach(b => b.classList.remove('hide'));
            };

            cancelBtn.addEventListener('click', cleanup);
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true;
              cancelBtn.disabled = true;
              const url = action === 'wipe-pool'
                ? '/api/admin/agents/' + encodeURIComponent(actionBtn.dataset.agent) +
                    '/pools/' + encodeURIComponent(actionBtn.dataset.ladder) + '/wipe'
                : '/api/admin/versions/' + encodeURIComponent(actionBtn.dataset.versionId) +
                    '/wipe';
              const errMsg = action === 'wipe-pool'
                ? 'Failed wiping saved teams.'
                : 'Failed wiping version.';
              try {
                await postJson(url, {});
                window.location.reload();
              } catch (err) {
                cleanup();
                showFeedback(err.message || errMsg, true);
              }
            });

            group.appendChild(confirmBtn);
            group.appendChild(cancelBtn);
            return;
          }
          if (action === 'quarantine') {
            const group = actionBtn.closest('.action-group');
            if (!group || group.querySelector('.confirm-quarantine')) return;
            const siblings = Array.from(group.querySelectorAll('button'));
            siblings.forEach(b => b.classList.add('hide'));

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
              siblings.forEach(b => b.classList.remove('hide'));
            };

            cancelBtn.addEventListener('click', cleanup);
            confirmBtn.addEventListener('click', async () => {
              confirmBtn.disabled = true;
              cancelBtn.disabled = true;
              input.disabled = true;
              try {
                await postJson(
                  '/api/admin/versions/' + encodeURIComponent(actionBtn.dataset.agent) + '/' +
                    encodeURIComponent(actionBtn.dataset.version) + '/quarantine',
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
            return;
          }
        }

        if (ev.target && ev.target.closest && ev.target.closest('a, button, input, label')) return;
        const row = ev.target && ev.target.closest ? ev.target.closest('tr.project-row') : null;
        if (row) toggleProjectRow(row);
      });

      projectsTbody.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        if (ev.target && ev.target.closest && ev.target.closest('a, button, input, label')) return;
        const row = ev.target && ev.target.closest ? ev.target.closest('tr.project-row') : null;
        if (row) {
          ev.preventDefault();
          toggleProjectRow(row);
        }
      });
    }

    ${account.buildDiagnosticReplayClientJs({
      apiPrefix: '/api/admin/diagnostics',
      rowSelector: 'tr.battle-row[data-diag-ids]',
    })}

    const wireServerPager = (opts) => {
      const pager = document.getElementById(opts.pagerId);
      const tbody = document.getElementById(opts.tbodyId);
      if (!pager || !tbody) return;
      const prevBtn = pager.querySelector('[data-pager-prev]');
      const nextBtn = pager.querySelector('[data-pager-next]');
      const pageSize = Number(pager.dataset.pageSize) || ${util.TABLE_PAGE_SIZE};
      let currentPage = 1;
      let fetchSeq = 0;

      const loadPage = async (targetPage) => {
        const seq = ++fetchSeq;
        if (prevBtn) prevBtn.disabled = true;
        if (nextBtn) nextBtn.disabled = true;
        try {
          const qs = '?page=' + targetPage + '&limit=' + pageSize;
          const res = await fetch(opts.endpoint + qs, {
            cache: 'no-cache',
            headers: {Accept: 'application/json'},
          });
          if (!res.ok) throw new Error('Request failed (' + res.status + ')');
          const data = await res.json();
          if (seq !== fetchSeq) return;
          if (typeof data.rowsHtml === 'string') {
            tbody.innerHTML = data.rowsHtml;
            pkmnTime.localize(tbody);
          }
          const state = updateTablePager(
            pager,
            data.page || targetPage,
            data.total || 0,
            data.pageSize || pageSize
          );
          currentPage = state.page;
          if (opts.onData) opts.onData(data);
          const sec = document.getElementById(opts.sectionId);
          if (sec) sec.scrollIntoView();
        } catch (err) {
          if (seq !== fetchSeq) return;
          showFeedback((err && err.message) || opts.errorMsg, true);
          if (prevBtn) prevBtn.disabled = currentPage <= 1;
          if (nextBtn) nextBtn.disabled = false;
        }
      };

      if (prevBtn) {
        prevBtn.addEventListener('click', () => {
          if (currentPage > 1) void loadPage(currentPage - 1);
        });
      }
      if (nextBtn) {
        nextBtn.addEventListener('click', () => {
          void loadPage(currentPage + 1);
        });
      }
    };

    const projectsTotalEl = document.getElementById('projects-total');
    wireServerPager({
      pagerId: 'projects-pager',
      tbodyId: 'projects-tbody',
      sectionId: 'projects',
      endpoint: '/api/admin/projects.json',
      errorMsg: 'Failed loading projects page.',
      onData: (data) => {
        if (projectsTotalEl && typeof data.total === 'number') {
          projectsTotalEl.textContent = String(data.total);
        }
      },
    });

    wireServerPager({
      pagerId: 'wiki-pager',
      tbodyId: 'wiki-tbody',
      sectionId: 'wiki',
      endpoint: '/api/admin/wiki-edits.json',
      errorMsg: 'Failed loading wiki edits page.',
    });

    const formatAge = (sec) => {
      const s = Math.max(0, Math.floor(sec));
      if (s < 60) return s + 's';
      if (s < 3600) return Math.floor(s / 60) + 'm';
      if (s < 86400) return Math.floor(s / 3600) + 'h';
      return Math.floor(s / 86400) + 'd';
    };

    const sysCards = document.getElementById('system-cards');
    const regSection = document.getElementById('registrations');
    let lastHbAt = sysCards && sysCards.dataset.heartbeatAt
      ? Number(sysCards.dataset.heartbeatAt)
      : NaN;
    let lastRegAt = regSection && regSection.dataset.checkedAt
      ? Number(regSection.dataset.checkedAt)
      : NaN;
    let clockOffsetSec = sysCards && sysCards.dataset.generatedAt
      ? Number(sysCards.dataset.generatedAt) - Math.floor(Date.now() / 1000)
      : 0;

    const tickAges = () => {
      const nowSec = Math.floor(Date.now() / 1000) + clockOffsetSec;
      const hbEl = document.getElementById('admin-hb-age');
      if (hbEl && Number.isFinite(lastHbAt)) {
        const ageSec = Math.max(0, nowSec - lastHbAt);
        hbEl.textContent = formatAge(ageSec) + ' ago';
        hbEl.className = ageSec > 900 ? 'no' : 'yes';
      }
      const regEl = document.getElementById('admin-reg-age');
      if (regEl && Number.isFinite(lastRegAt)) {
        const ageSec = Math.max(0, nowSec - lastRegAt);
        regEl.textContent = formatAge(ageSec) + ' ago';
      }
    };

    setInterval(tickAges, 1000);

    const bindTablePagers = () => {
      ${util.TABLE_PAGER_SCRIPT}
    };
    bindTablePagers();

    const applyRegistrations = (payload) => {
      if (!regSection) return;
      if (typeof payload.generatedAt === 'number') {
        clockOffsetSec = payload.generatedAt - Math.floor(Date.now() / 1000);
      }
      if (typeof payload.checkedAt === 'number') {
        lastRegAt = payload.checkedAt;
        regSection.dataset.checkedAt = String(lastRegAt);
      } else if ('checkedAt' in payload) {
        lastRegAt = NaN;
        regSection.dataset.checkedAt = '';
      }
      if (typeof payload.innerHtml === 'string') {
        regSection.innerHTML = payload.innerHtml;
        pkmnTime.localize(regSection);
        bindTablePagers();
      }
    };

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
            pkmnTime.localize(sysCards);
          }
        } catch {}
      });
      es.addEventListener('registrations', (ev) => {
        try {
          applyRegistrations(JSON.parse(ev.data));
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

function formatAdminReason(reason?: string): string {
  if (!reason) return '';
  let m = /^14-day cooldown active \((\d+d) remaining after .+\)\.$/.exec(reason);
  if (m) return `${m[1]} cooldown remaining.`;
  m = /^Active version (\S+) on (\S+) has not settled \((.+)\)\.$/.exec(reason);
  if (m) return `Unsettled ${m[2]} ${m[1]} (${m[3]}).`;
  m = /^Version (\S+) passed diagnostic testing; activate or discard/.exec(reason);
  if (m) return `Staged ${m[1]} awaiting activation.`;
  if (reason === 'Project qualification is pending staff review.') {
    return 'Pending staff review.';
  }
  return reason;
}

function formatFaultCounts(
  crashes: number,
  timeouts: number,
  ooms: number,
  invalidChoices = 0
): string[] {
  const out: string[] = [];
  if (crashes > 0) out.push(`${crashes} ${crashes === 1 ? 'crash' : 'crashes'}`);
  if (timeouts > 0) out.push(`${timeouts} ${timeouts === 1 ? 'timeout' : 'timeouts'}`);
  if (ooms > 0) out.push(`${ooms} ${ooms === 1 ? 'OOM' : 'OOMs'}`);
  if (invalidChoices > 0) out.push(`${invalidChoices} invalid choice`);
  return out;
}

function totalProtocolErrors(e: db.AdminEntryView): number {
  return e.invalidCantMove + e.invalidCantSwitch + e.invalidTarget + e.invalidOther;
}

function formatEntryFaultTooltip(e: db.AdminEntryView): string | undefined {
  const gameParts: string[] = [];
  if (e.crashes > 0) gameParts.push(`Crashes: ${e.crashes}`);
  if (e.timeouts > 0) gameParts.push(`Timeouts: ${e.timeouts}`);
  if (e.ooms > 0) gameParts.push(`OOMs: ${e.ooms}`);
  if (e.invalidChoices > 0) gameParts.push(`Invalid choice: ${e.invalidChoices}`);
  const protoParts: string[] = [];
  if (e.invalidCantMove > 0) protoParts.push(`Can't move: ${e.invalidCantMove}`);
  if (e.invalidCantSwitch > 0) protoParts.push(`Can't switch: ${e.invalidCantSwitch}`);
  if (e.invalidTarget > 0) protoParts.push(`Invalid target: ${e.invalidTarget}`);
  if (e.invalidOther > 0) protoParts.push(`Other invalid: ${e.invalidOther}`);
  if (e.unavailableChoices > 0) {
    protoParts.push(`Unavailable choices (info): ${e.unavailableChoices}`);
  }
  const sections: string[] = [];
  if (gameParts.length > 0) sections.push(`Game faults — ${gameParts.join(' · ')}`);
  if (protoParts.length > 0) sections.push(`Protocol errors — ${protoParts.join(' · ')}`);
  return sections.length > 0 ? sections.join('\n') : undefined;
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
  const totalIo = d.readBytesPerSecond !== undefined && d.writeBytesPerSecond !== undefined
    ? d.readBytesPerSecond + d.writeBytesPerSecond
    : d.ioBytesPerSecond;
  const ioParts: string[] = [];
  if (totalIo !== undefined) ioParts.push(formatRate(totalIo));
  if (d.iops !== undefined) ioParts.push(`${d.iops} IOPS`);
  const busyHigh = d.busyPct !== undefined && d.busyPct >= 80;
  const tipParts: string[] = [d.mount];
  if (d.readBytesPerSecond !== undefined && d.writeBytesPerSecond !== undefined) {
    tipParts.push(`R ${formatRate(d.readBytesPerSecond)} · W ${formatRate(d.writeBytesPerSecond)}`);
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
  const titleParts: util.LocalizedTitlePart[] = [{prefix: 'Checked ', epoch: updates.checkedAt}];
  if (updates.summary) titleParts.push(updates.summary);
  const titleAttrs = util.localizedTitle(titleParts);
  return (
    <>
      <span className={countClass} {...titleAttrs}>
        {updates.pending === 0
          ? 'None'
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
    const titleAttrs = util.localizedTitle([{prefix: 'Checked ', epoch: probe.checkedAt}]);
    return (
      <span className={slow ? 'warn' : 'yes'} {...titleAttrs}>
        {probe.target}
        {probe.rttMillis !== undefined ? ` ${probe.rttMillis}ms` : ' ok'}
      </span>
    );
  }
  const titleParts: util.LocalizedTitlePart[] = [];
  if (probe.error) titleParts.push(probe.error);
  titleParts.push({prefix: 'Checked ', epoch: probe.checkedAt});
  return (
    <span className='no' {...util.localizedTitle(titleParts)}>
      {probe.target} {probe.error ?? 'down'}
    </span>
  );
}

function buildBackupTooltip(
  b: system.BackupStatus
): util.LocalizedTitleAttrs | Record<string, never> {
  const parts: util.LocalizedTitlePart[] = [];
  if (b.lastBackupAt !== undefined) parts.push({prefix: 'Backup: ', epoch: b.lastBackupAt});
  if (b.lastArchiveUploadAt !== undefined) {
    parts.push({prefix: 'GCS sync: ', epoch: b.lastArchiveUploadAt});
  }
  if (b.checkedAt !== undefined) parts.push({prefix: 'Checked: ', epoch: b.checkedAt});
  return util.localizedTitle(parts);
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
  const sampleAttrs = util.localizedTitle([{prefix: 'Sampled ', epoch: info.collectedAt}]);
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
  stagedCount: number;
  unsentDms: number;
  smokeCadence: db.SmokeCadence;
}

function formatSmokeCadence(cadence: db.SmokeCadence): {
  text: string;
  className: string;
  title: string;
} {
  if (cadence.maxPerCycle <= 0) {
    return {
      text: 'Smoke paused',
      className: 'warn',
      title:
        'Smoke-test cadence: paused (0 per match cycle) — configure via pkmn set-smoke-cadence',
    };
  }
  if (cadence.everyCycles <= 1) {
    return {
      text: `Smoke ${cadence.maxPerCycle}/match`,
      className: 'muted',
      title:
        `Smoke-test cadence: up to ${cadence.maxPerCycle} per match cycle ` +
        '— configure via pkmn set-smoke-cadence',
    };
  }
  return {
    text: `Smoke ${cadence.maxPerCycle}/${cadence.everyCycles} matches`,
    className: 'muted',
    title:
      `Smoke-test cadence: up to ${cadence.maxPerCycle} every ${cadence.everyCycles} ` +
      'match cycles — configure via pkmn set-smoke-cadence',
  };
}

function renderArenaQueueLine(extras: SystemCardExtras, outboxPending?: number): util.Child {
  const cadence = formatSmokeCadence(extras.smokeCadence);
  return (
    <span className='sys-line'>
      <span
        className={extras.pendingQueue > 0 ? 'warn' : 'muted'}
        title='Submitted versions waiting for Arena smoke testing'
      >
        Queue {extras.pendingQueue} pending
      </span>
      {extras.stagedCount > 0 && (
        <>
          {' · '}
          <span
            className='warn'
            title='Diagnostic smoke runs awaiting owner activation or discard'
          >
            {extras.stagedCount} staged
          </span>
        </>
      )}
      {outboxPending !== undefined && (
        <>
          {' · '}
          <span
            className={outboxPending > 0 ? 'warn' : 'muted'}
            title='Completed match/smoke payloads buffered on Arena awaiting VPS flush'
          >
            Outbox {outboxPending}
          </span>
        </>
      )}
      {' · '}
      <span className={cadence.className} title={cadence.title}>
        {cadence.text}
      </span>
    </span>
  );
}

function renderSystemCards(
  sys: AdminSystemSnapshot,
  now: number,
  extras: SystemCardExtras
): util.Html {
  const {vps, arena: arenaSys, lastHeartbeatAt} = sys;
  const vpsSampleAttrs = util.localizedTitle([{prefix: 'Sampled ', epoch: vps.collectedAt}]);
  const arenaSampleAttrs = arenaSys
    ? util.localizedTitle([{prefix: 'Sampled ', epoch: arenaSys.collectedAt}])
    : {};

  const vpsNetErrs = (vps.network.rxErrors ?? 0) + (vps.network.txErrors ?? 0);
  const tlsClass = vps.tlsCert
    ? (vps.tlsCert.daysRemaining < TLS_CRIT_DAYS
      ? 'no'
      : vps.tlsCert.daysRemaining < TLS_WARN_DAYS ? 'warn' : 'muted')
    : 'muted';
  const tlsTitleAttrs = vps.tlsCert
    ? util.localizedTitle([
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
    ? util.localizedTitle([
      `Last: ${vps.traffic.last5xx.status} ${vps.traffic.last5xx.path}`,
      {prefix: 'at ', epoch: vps.traffic.last5xx.at},
    ])
    : {};

  const hbStale = lastHeartbeatAt === undefined || now - lastHeartbeatAt > HEARTBEAT_STALE_SECONDS;
  const hbTitleAttrs = lastHeartbeatAt !== undefined
    ? util.localizedTitle([{prefix: 'Last heartbeat ', epoch: lastHeartbeatAt}])
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
                {vps.network.rxBytesPerSecond !== undefined &&
                  vps.network.txBytesPerSecond !== undefined &&
                  ` ↓${formatRate(vps.network.rxBytesPerSecond)} ` +
                  `↑${formatRate(vps.network.txBytesPerSecond)}`}
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
          <>
            <p className='muted' style={{margin: '0.25rem 0 0.55rem', fontSize: '0.88em'}}>
              Waiting for Arena host telemetry on the next heartbeat.
            </p>
            <dl className='sys-dl'>
              <dt>Runtime</dt>
              <dd>{renderArenaQueueLine(extras)}</dd>
            </dl>
          </>
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
                  {arenaSys.network.rxBytesPerSecond !== undefined &&
                    arenaSys.network.txBytesPerSecond !== undefined &&
                    ` ↓${formatRate(arenaSys.network.rxBytesPerSecond)} ` +
                    `↑${formatRate(arenaSys.network.txBytesPerSecond)}`}
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
                        ? util.localizedTitle([
                          {prefix: 'Checked ', epoch: arenaSys.podmanCheckedAt},
                        ])
                        : {})}
                    >
                      Podman {arenaSys.podmanState}
                    </span>
                  </>
                )}
              </span>
              {renderArenaQueueLine(extras, arenaSys.outboxPending)}
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

function parseIsoEpochSeconds(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const millis = Date.parse(raw);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined;
}

export function parseRegistrationIssues(
  raw: unknown,
  repo = REGISTRATION_REPO
): RegistrationIssue[] {
  if (!Array.isArray(raw)) {
    throw new Error('Unexpected GitHub API response');
  }
  const issues: RegistrationIssue[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    if (item.pull_request !== undefined && item.pull_request !== null) continue;
    const num = item.number;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const createdAt = parseIsoEpochSeconds(item.created_at);
    const updatedAt = parseIsoEpochSeconds(item.updated_at) ?? createdAt;
    if (
      typeof num !== 'number' ||
      !Number.isSafeInteger(num) ||
      num <= 0 ||
      !title ||
      createdAt === undefined ||
      updatedAt === undefined
    ) {
      continue;
    }
    const user = item.user && typeof item.user === 'object'
      ? (item.user as Record<string, unknown>)
      : undefined;
    const author = typeof user?.login === 'string' && user.login.trim()
      ? user.login.trim()
      : 'ghost';
    const comments = typeof item.comments === 'number' &&
      Number.isFinite(item.comments) &&
      item.comments >= 0
      ? Math.floor(item.comments)
      : 0;
    issues.push({
      number: num,
      title,
      url: `https://github.com/${repo}/issues/${num}`,
      author,
      authorUrl: `https://github.com/${encodeURIComponent(author)}`,
      createdAt,
      updatedAt,
      comments,
    });
  }
  issues.sort((a, b) => b.updatedAt - a.updatedAt || b.number - a.number);
  return issues;
}

export class RegistrationIssueMonitor {
  private readonly repo: string;
  private readonly url: string;
  private readonly token: string | undefined;
  private readonly pollIntervalMillis: number;
  private readonly fetchTimeoutMillis: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly listeners: Set<() => void>;
  private issues: RegistrationIssue[];
  private checkedAt: number | undefined;
  private error: string | undefined;
  private etag: string | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private inflight: Promise<RegistrationIssuesSnapshot> | undefined;

  constructor(opts: RegistrationMonitorOptions = {}) {
    this.repo = opts.repo ?? REGISTRATION_REPO;
    const label = opts.label ?? REGISTRATION_LABEL;
    this.url =
      `https://api.github.com/repos/${this.repo}/issues` +
      `?labels=${encodeURIComponent(label)}&state=open&sort=updated&direction=desc&per_page=100`;
    this.token = (opts.token ?? process.env.GITHUB_TOKEN)?.trim() || undefined;
    this.pollIntervalMillis = opts.pollIntervalMillis ?? REGISTRATION_POLL_MILLIS;
    this.fetchTimeoutMillis = opts.fetchTimeoutMillis ?? REGISTRATION_FETCH_TIMEOUT_MILLIS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.listeners = new Set();
    this.issues = [];
    this.checkedAt = undefined;
    this.error = undefined;
    this.etag = undefined;
    this.timer = undefined;
    this.inflight = undefined;
  }

  start(): void {
    if (this.timer) return;
    this.poll().catch(() => {});
    this.timer = setInterval(() => {
      this.poll().catch(() => {});
    }, this.pollIntervalMillis);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  onUpdate(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): RegistrationIssuesSnapshot {
    return {
      issues: this.issues.map(i => ({...i})),
      ...(this.checkedAt !== undefined ? {checkedAt: this.checkedAt} : {}),
      ...(this.error !== undefined ? {error: this.error} : {}),
    };
  }

  poll(): Promise<RegistrationIssuesSnapshot> {
    if (this.inflight) return this.inflight;
    const run = this.doPoll().finally(() => {
      if (this.inflight === run) this.inflight = undefined;
    });
    this.inflight = run;
    return run;
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('Registration issue listener failed:', err);
      }
    }
  }

  private async doPoll(): Promise<RegistrationIssuesSnapshot> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'pkmn.ai',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.etag) headers['If-None-Match'] = this.etag;

    try {
      const res = await this.fetchImpl(this.url, {
        headers,
        signal: AbortSignal.timeout(this.fetchTimeoutMillis),
      });
      const checkedAt = this.now();
      if (res.status === 304) {
        this.checkedAt = checkedAt;
        this.error = undefined;
      } else if (!res.ok) {
        const rateLimited =
          (res.status === 403 || res.status === 429) &&
          res.headers.get('x-ratelimit-remaining') === '0';
        this.checkedAt = checkedAt;
        this.error = rateLimited
          ? 'GitHub API rate limit exceeded'
          : `GitHub API returned HTTP ${res.status}`;
      } else {
        const data = await util.parseJsonResponse<unknown>(res, 'GitHub API');
        const parsed = parseRegistrationIssues(data, this.repo);
        const etag = res.headers.get('etag')?.trim();
        if (etag) this.etag = etag;
        this.issues = parsed;
        this.checkedAt = checkedAt;
        this.error = undefined;
      }
    } catch (err) {
      this.checkedAt = this.now();
      this.error = util.isConnectivityError(err)
        ? 'GitHub unreachable'
        : err instanceof Error ? err.message : 'GitHub poll failed';
    }

    this.notify();
    return this.getSnapshot();
  }
}

export function buildAdminAgentsPage(
  database: db.Database,
  now = Math.floor(Date.now() / 1000),
  limit = util.TABLE_PAGE_SIZE,
  offset = 0,
  currentLadders = database.getCurrentLadders(),
  discordRoleMembersByAgent?: ReadonlyMap<number, AgentDiscordMember[]>
): {agents: AdminAgentItem[]; total: number} {
  const {agents: pageAgents, total} = database.getAgentsPage(limit, offset);
  const devsByAgent = database.getDevelopersByAgent();
  const laddersByAgent = database.getAgentLaddersByAgent();
  const entriesByAgent = database.getAdminEntriesByAgent();
  const poolsByAgent = database.getTeamPoolCountsByAgent();
  const wipeablePoolsByAgent = database.getWipeableSavedPools();
  const tourneysByAgent = database.getTournamentEntrantsByAgent();
  const poolLadders = currentLadders.filter(l => l.team === 'pools' && l.teams);

  const agents: AdminAgentItem[] = pageAgents.map(agent => {
    const agentPools = poolsByAgent.get(agent.id);
    const wipeablePools = wipeablePoolsByAgent.get(agent.id);
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
          wipeable: wipeablePools?.has(pl.id) ?? false,
        });
      }
    }
    return {
      agent,
      developers: devsByAgent.get(agent.id) ?? [],
      discordRoleMembers: discordRoleMembersByAgent?.get(agent.id) ?? [],
      qualifiedLadders: laddersByAgent.get(agent.id) ?? [],
      submissionStatus: database.computeAgentSubmissionStatus(agent.id, now),
      pools,
      tournaments: tourneysByAgent.get(agent.id) ?? [],
      entries: entriesByAgent.get(agent.id) ?? [],
      versions: database.getVersionsForAgent(agent.id),
    };
  });

  return {agents, total};
}

export function buildAdminSnapshot(
  database: db.Database,
  adminLogin: string,
  arenaHandle?: arena.Handle,
  now = Math.floor(Date.now() / 1000),
  systemSnapshot?: AdminSystemSnapshot,
  wikiEditsPage: {edits: wiki.RecentEdit[]; total: number} = {edits: [], total: 0},
  registrations: RegistrationIssuesSnapshot = {issues: []},
  discordRoleMembersByAgent?: ReadonlyMap<number, AgentDiscordMember[]>
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

  const {agents, total: totalAgents} = buildAdminAgentsPage(
    database,
    now,
    util.TABLE_PAGE_SIZE,
    0,
    currentLadders,
    discordRoleMembersByAgent
  );

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

  const matches24h = ladders.reduce((acc, item) => acc + item.summary.matches24h, 0);
  const totalMatches = ladders.reduce((acc, item) => acc + item.summary.totalMatches, 0);
  const submissions = database.getSubmissionAdminSummary(now);
  const smokeCadence = database.getSmokeCadence();

  return {
    generatedAt: now,
    admin: adminLogin,
    system: sys,
    health: {
      runner: computeRunnerHealth(arenaHandle, now),
      pendingSubmissions,
      stagedCount: submissions.stagedCount,
      unsentDmCount: database.getPendingVersionDms().length,
      discordMemberCount: database.countDiscordMembers(),
      smokeCadence,
    },
    ladders,
    matches24h,
    totalMatches,
    submissions,
    registrations,
    agents,
    totalAgents,
    wipeableVersionIds: database.getWipeableVersionIds(),
    wikiEdits: wikiEditsPage.edits,
    totalWikiEdits: wikiEditsPage.total,
  };
}

function renderLaddersSection(
  ladders: AdminLadderItem[],
  matches24h: number,
  totalMatches: number
): util.Child {
  return (
    <section id='ladders'>
      <div className='section-head'>
        <h3><a href='#ladders' className='subtle'>Ladders</a></h3>
        <span
          className='section-meta muted'
          title='Total matches completed across current ladders in the last 24h / all-time'
        >
          {matches24h.toLocaleString('en-US')}/{totalMatches.toLocaleString('en-US')}
        </span>
      </div>
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
                        {summary.anchor.agentName}{' '}
                        <code className='muted'>{summary.anchor.version}</code>
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
  ladderNameById: ReadonlyMap<string, string>,
  wipeableVersionIds: ReadonlySet<number>
): util.Child {
  const {agent, entries, versions, pools, tournaments} = item;
  const activeMeta: util.Child[] = [];
  if (pools.length > 0) {
    activeMeta.push(
      <span className='pool-meta'>
        <span className='muted'>Pools:</span>
        {pools.map((p, idx) => (
          <>
            {idx > 0 && <span className='muted'>{'\u00b7'}</span>}
            <span className='pool-item'>
              <span>{formatPoolProgress(p)}</span>
              {p.wipeable && (
                <span className='action-group'>
                  <button
                    type='button'
                    className='btn-sm btn-danger'
                    data-action='wipe-pool'
                    data-agent={agent.slug}
                    data-ladder={p.ladderId}
                    title={`Wipe saved ${p.ladderName} teams for ${agent.name}`}
                  >
                    Wipe
                  </button>
                </span>
              )}
            </span>
          </>
        ))}
      </span>
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
                  const gameFaults = e.crashes + e.timeouts + e.ooms + e.invalidChoices;
                  const protoErrs = totalProtocolErrors(e);
                  const faultTip = formatEntryFaultTooltip(e) ?? 'No recorded faults';
                  const hasCpu = e.cpuMatches > 0 && e.meanCpuCores > 0;
                  return (
                    <tr>
                      <td><strong>{e.ladderName}</strong></td>
                      <td>
                        <code>{e.version}</code>
                        {util.renderInfoDot(e.smokeInfoStatus)}
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
                        {hasCpu && <> · {e.meanCpuCores.toFixed(1)} CPU</>}
                      </td>
                      <td className='num' title={faultTip}>
                        {gameFaults > 0 ? (
                          <span className='no'>{gameFaults}</span>
                        ) : protoErrs > 0 ? (
                          <span className='warn'>0</span>
                        ) : (
                          <span className='muted'>0</span>
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
                        <util.Time
                          epoch={t.startsAt}
                          format='date'
                          title={[{prefix: 'Starts ', epoch: t.startsAt}]}
                        />
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
        <h4>
          History ({versions.length > 15 ? `latest 15 of ${versions.length}` : versions.length})
        </h4>
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
                  const statsText = account.formatSmokeStatsText(v);
                  const diagLinks = account.renderDiagnosticLinks(
                    v.diagnostics,
                    ladderNameById,
                    '/api/admin/diagnostics'
                  );
                  const playableDiags = (v.diagnostics ?? []).filter(d => d.hasLog);
                  const isTournamentOnly =
                    v.ladders.length === 0 && (v.tournamentNames?.length ?? 0) > 0;
                  const isRetired =
                    v.smokeStatus === 'passed' &&
                    !isTournamentOnly &&
                    v.activeLadderNames.length === 0;

                  let smokeEl: util.Child;
                  if (v.smokeStatus === 'pending') {
                    smokeEl = <span className='warn'>PENDING</span>;
                  } else if (v.smokeStatus === 'staged') {
                    smokeEl = (
                      <>
                        <span className='yes'>PASS</span>{' '}
                        <span className='warn'>(staged)</span>{' '}
                        <span className={v.notified ? 'muted' : 'warn'}>
                          ({v.notified ? 'DM sent' : 'DM unsent'})
                        </span>
                        {statsText && <> <span className='muted'>({statsText})</span></>}
                        {diagLinks}
                      </>
                    );
                  } else if (v.smokeStatus === 'passed' || v.smokeStatus === 'discarded') {
                    smokeEl = (
                      <>
                        {isRetired || v.smokeStatus === 'discarded'
                          ? <span>PASS</span>
                          : <span className='yes'>PASS</span>}
                        {statsText && <> <span className='muted'>({statsText})</span></>}
                        {diagLinks}
                      </>
                    );
                  } else {
                    const showInlineError = Boolean(v.smokeError) && (
                      v.smokeStatus === 'quarantined' || !v.diagnostics?.length
                    );
                    smokeEl = (
                      <>
                        <span className='no'>
                          {v.smokeStatus === 'quarantined' ? 'QUARANTINED' : 'FAIL'}
                        </span>{' '}
                        <span className={v.notified ? 'muted' : 'warn'}>
                          ({v.notified ? 'DM sent' : 'DM unsent'})
                        </span>
                        {showInlineError && (
                          <div className='smoke-error muted'>{v.smokeError}</div>
                        )}
                        {diagLinks}
                      </>
                    );
                  }

                  let stateEl: util.Child;
                  if (v.smokeStatus === 'pending') {
                    stateEl = <span className='muted'>Pending</span>;
                  } else if (v.smokeStatus === 'staged') {
                    stateEl = (
                      <span
                        className='warn'
                        title='Passed diagnostic smoke test; awaiting owner activation or discard'
                      >
                        Staged
                      </span>
                    );
                  } else if (v.smokeStatus === 'discarded') {
                    stateEl = <span className='muted'>Discarded</span>;
                  } else if (v.smokeStatus === 'failed') {
                    stateEl = <span className='muted'>Rejected</span>;
                  } else if (v.smokeStatus === 'quarantined') {
                    stateEl = <span className='no'>Quarantined</span>;
                  } else {
                    const activatedAttrs = v.activatedAt !== undefined
                      ? util.localizedTitle([{prefix: 'Activated ', epoch: v.activatedAt}])
                      : {};
                    const label = v.activeLadderNames.length > 0
                      ? `Active (${v.activeLadderNames.join(', ')})`
                      : isTournamentOnly
                        ? 'Entered'
                        : 'Retired';
                    stateEl = <span {...activatedAttrs}>{label}</span>;
                  }

                  const rowClasses: string[] = [];
                  if (playableDiags.length > 0) rowClasses.push('battle-row');
                  if (isRetired || v.smokeStatus === 'discarded') rowClasses.push('secondary');
                  return (
                    <tr
                      className={rowClasses.length > 0 ? rowClasses.join(' ') : undefined}
                      data-diag-ids={playableDiags.length > 0
                        ? playableDiags.map(d => String(d.id)).join(',')
                        : undefined}
                      data-diag-labels={playableDiags.length > 0
                        ? playableDiags
                          .map(d => account.diagnosticTargetLabel(d, ladderNameById))
                          .join('|')
                        : undefined}
                      tabIndex={playableDiags.length > 0 ? 0 : undefined}
                      aria-expanded={playableDiags.length > 0 ? 'false' : undefined}
                    >
                      <td>
                        {playableDiags.length > 0 && (
                          <span className='battle-toggle' aria-hidden='true'>{'\u25b8'}</span>
                        )}
                        <code>{v.version}</code>
                        {util.renderInfoDot(v.smokeInfoStatus)}
                      </td>
                      <td className='wrap'><tt>{targets.join(', ') || '—'}</tt></td>
                      <td className='wrap'>{smokeEl}</td>
                      <td>{stateEl}</td>
                      <td className='num muted'>
                        <util.Time
                          epoch={v.submittedAt}
                          format='date'
                          title={[{prefix: 'Submitted ', epoch: v.submittedAt}]}
                        />
                      </td>
                      <td>
                        <span className='action-group'>
                          {v.smokeStatus === 'staged' && (
                            <button
                              type='button'
                              className='btn-sm btn-danger'
                              data-action='discard'
                              data-version-id={String(v.id)}
                              data-agent={agent.slug}
                              data-version={v.version}
                              title={`Discard staged version ${v.version}`}
                            >
                              Discard
                            </button>
                          )}
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
                          {wipeableVersionIds.has(v.id) && (
                            <button
                              type='button'
                              className='btn-sm btn-danger'
                              data-action='wipe'
                              data-version-id={String(v.id)}
                              data-agent={agent.slug}
                              data-version={v.version}
                              title={
                                `Wipe unplayed version ${v.version} from DB and runner archives`
                              }
                            >
                              Wipe
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

function renderWikiEditRows(edits: wiki.RecentEdit[]): util.Html {
  return (
    <>
      {edits.map(edit => {
        const ghUrl = `https://github.com/${encodeURIComponent(edit.author)}`;
        const isProject = edit.slug.startsWith('projects/');
        return (
          <tr>
            <td className='muted'>
              <util.Time epoch={edit.timestamp} format='date' />
            </td>
            <td>
              <a href={edit.deleted ? edit.historyHref : edit.pageHref} className='subtle'>
                {isProject && <span className='muted'>projects/</span>}
                {edit.title}
              </a>
              {edit.deleted && <span className='muted'> (deleted)</span>}
            </td>
            <td>
              {edit.deleted
                ? <code>{edit.shortSha}</code>
                : <code><a href={edit.revisionHref}>{edit.shortSha}</a></code>}{' '}
              (<a href={edit.diffHref}>diff</a>)
            </td>
            <td>
              <a href={ghUrl} className='subtle'>{edit.displayAuthor}</a>
            </td>
            <td className='wrap'>{edit.subject}</td>
          </tr>
        );
      })}
    </>
  );
}

function renderWikiEditsSection(edits: wiki.RecentEdit[], total: number): util.Child {
  return (
    <section id='wiki'>
      <h3><a href='#wiki' className='subtle'>Wiki</a></h3>
      {total === 0 ? (
        <p className='muted'>No wiki edits yet.</p>
      ) : (
        <util.PaginatedTable
          tbodyId='wiki-tbody'
          head={(
            <tr>
              <th>Date</th>
              <th>Page</th>
              <th>Revision</th>
              <th>Author</th>
              <th>Summary</th>
            </tr>
          )}
          pager={{
            id: 'wiki-pager',
            label: 'Wiki edits pagination',
            total,
            singular: 'edit',
            plural: 'edits',
            prevLabel: '\u2190 Newer',
            nextLabel: 'Older \u2192',
            server: true,
          }}
        >
          {renderWikiEditRows(edits)}
        </util.PaginatedTable>
      )}
    </section>
  );
}

function renderProjectRows(
  agents: AdminAgentItem[],
  ladderNameById: ReadonlyMap<string, string>,
  wipeableVersionIds: ReadonlySet<number>
): util.Html {
  return (
    <>
      {agents.map(item => {
        const {agent, developers, qualifiedLadders, submissionStatus} = item;
        const qualifiedSet = new Set(qualifiedLadders);
        const isDisabled = agent.status === 'disabled';
        const statusClass = submissionStatus.label === 'Eligible'
          ? 'yes'
          : submissionStatus.label === 'Ineligible' ? 'no' : 'muted';
        const hasCooldown = submissionStatus.nextEligibleAt !== undefined;
        const activeEntries = item.entries.filter(e => e.role !== 'quarantined');
        const quarantinedEntries = item.entries.filter(e => e.role === 'quarantined');
        const stagedVersions = item.versions.filter(v => v.smokeStatus === 'staged');
        const linkedDiscord = developers.filter(
          d => Boolean(d.discordId && d.discordUsername)
        );
        const linkedDiscordIds = new Set(linkedDiscord.map(d => d.discordId!));
        const inferredDiscord = item.discordRoleMembers.filter(
          m => !linkedDiscordIds.has(m.discordId)
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
                {linkedDiscord.length === 0 && inferredDiscord.length === 0 ? (
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
                    {inferredDiscord.map(member => (
                      <a
                        href={`https://discord.com/users/${encodeURIComponent(member.discordId)}`}
                        target='_blank'
                        rel='noopener noreferrer'
                        className='subtle discord-inferred'
                        title={
                          `DM @${member.discordUsername} on Discord · ` +
                          'Matched via 🤖 project role (not manually linked; no system DMs)'
                        }
                      >
                        @{member.discordUsername}
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
                    {!isDisabled && (
                      <button
                        type='button'
                        className={agent.unlimitedSmokeTests ? 'btn-sm btn-warn' : 'btn-sm'}
                        data-action='smoke-limit'
                        data-agent={agent.slug}
                        data-unlimited={agent.unlimitedSmokeTests ? 'true' : 'false'}
                        title={
                          agent.unlimitedSmokeTests
                            ? 'Re-enable the 3-per-24h failed/discarded diagnostic rate limit'
                            : 'Disable the 3-per-24h failed/discarded diagnostic rate limit'
                        }
                      >
                        {agent.unlimitedSmokeTests ? 'Unlimited' : 'Limited'}
                      </button>
                    )}
                  </div>
                  <span
                    className={
                      conciseReason
                        ? 'muted status-reason'
                        : 'muted status-reason hide'
                    }
                    {...(submissionStatus.reason
                      ? util.localizedTitleFromText(submissionStatus.reason)
                      : {})}
                  >
                    {util.renderLocalizedText(conciseReason)}
                  </span>
                  {!isDisabled && (
                    <span
                      className={
                        agent.unlimitedSmokeTests
                          ? 'warn status-note smoke-limit-note'
                          : 'warn status-note smoke-limit-note hide'
                      }
                    >
                      3/24h limit disabled.
                    </span>
                  )}
                  {item.pools.map(p => (
                    <span className='muted status-note'>
                      {formatPoolProgress(p)}
                    </span>
                  ))}
                </div>
              </td>
              <td className='wrap'>
                {activeEntries.length === 0 &&
                  quarantinedEntries.length === 0 &&
                  stagedVersions.length === 0 &&
                  item.tournaments.length === 0 ? (
                    <span className='muted'>—</span>
                  ) : (
                    <div className='chip-list'>
                      {activeEntries.map(e => {
                        const faults = formatFaultCounts(
                          e.crashes,
                          e.timeouts,
                          e.ooms,
                          e.invalidChoices
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
                      {stagedVersions.map(v => (
                        <span
                          className='chip chip-warn'
                          title={
                            `Staged version ${v.version} awaiting owner activation ` +
                            'or discard'
                          }
                        >
                          {v.version}
                        </span>
                      ))}
                      {item.tournaments.map(t => {
                        const tName = formatTournamentName(t.tournamentName);
                        return (
                          <span
                            className='chip'
                            {...util.localizedTitle([
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
                {renderProjectDetailPanel(item, ladderNameById, wipeableVersionIds)}
              </td>
            </tr>
          </>
        );
      })}
    </>
  );
}

interface AuthorProject {
  slug: string;
  name: string;
}

function buildAuthorProjectsFromAgents(
  agents: readonly AdminAgentItem[]
): Map<string, AuthorProject> {
  const out = new Map<string, AuthorProject>();
  for (const item of agents) {
    for (const dev of item.developers) {
      out.set(dev.githubLogin.toLowerCase(), {slug: item.agent.slug, name: item.agent.name});
    }
  }
  return out;
}

function buildAuthorProjectsFromDb(database: db.Database): Map<string, AuthorProject> {
  const out = new Map<string, AuthorProject>();
  const devsByAgent = database.getDevelopersByAgent();
  for (const agent of database.getAllAgents()) {
    for (const dev of devsByAgent.get(agent.id) ?? []) {
      out.set(dev.githubLogin.toLowerCase(), {slug: agent.slug, name: agent.name});
    }
  }
  return out;
}

function renderRegistrationsInner(
  registrations: RegistrationIssuesSnapshot,
  now: number,
  authorProjects: ReadonlyMap<string, AuthorProject>
): util.Html {
  const {issues, checkedAt, error} = registrations;
  const count = issues.length;
  const checkedAttrs = checkedAt !== undefined
    ? util.localizedTitle([{prefix: 'Checked ', epoch: checkedAt}])
    : {};
  return (
    <>
      <div className='section-head'>
        <h3>
          <a href='#registrations' className='subtle'>Registrations ({count})</a>
        </h3>
        {checkedAt !== undefined && (
          <span className='section-meta muted' {...checkedAttrs}>
            Checked <span id='admin-reg-age'>{formatAge(now - checkedAt)} ago</span>
          </span>
        )}
      </div>
      {error && (
        <p className='warn reg-error'>
          {count > 0
            ? `Last poll failed: ${error} (showing last known issues).`
            : `Unable to poll GitHub registration issues: ${error}.`}
        </p>
      )}
      {count === 0 ? (
        !error && <p className='muted'>No open registration issues.</p>
      ) : (
        <util.PaginatedTable
          head={
            <tr>
              <th>Opened</th>
              <th>Issue</th>
              <th>Author</th>
              <th className='num'>Comments</th>
              <th className='num'>Updated</th>
            </tr>
          }
          pager={{
            id: 'registrations-pager',
            label: 'Registration issues pagination',
            total: issues.length,
            singular: 'issue',
            plural: 'issues',
          }}
        >
          {issues.map((issue, idx) => {
            const existing = authorProjects.get(issue.author.toLowerCase());
            return (
              <tr className={idx >= util.TABLE_PAGE_SIZE ? 'hide' : undefined}>
                <td className='muted'>
                  <util.Time
                    epoch={issue.createdAt}
                    format='date'
                    title={[{prefix: 'Opened ', epoch: issue.createdAt}]}
                  />
                </td>
                <td className='wrap'>
                  <a
                    href={issue.url}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='subtle'
                  >
                    <code>#{issue.number}</code> <strong>{issue.title}</strong>
                  </a>
                </td>
                <td>
                  <a
                    href={issue.authorUrl}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='subtle'
                  >
                    {issue.author}
                  </a>
                  {existing && (
                    <>
                      {' '}
                      <span className='muted'>
                        (
                        <a
                          href={`/projects/${encodeURIComponent(existing.slug)}/`}
                          className='subtle'
                        >
                          {existing.name}
                        </a>
                        )
                      </span>
                    </>
                  )}
                </td>
                <td className='num'>
                  {issue.comments > 0 ? issue.comments : <span className='muted'>0</span>}
                </td>
                <td className='num muted'>
                  <util.Time
                    epoch={issue.updatedAt}
                    format='date'
                    title={[{prefix: 'Updated ', epoch: issue.updatedAt}]}
                  />
                </td>
              </tr>
            );
          })}
        </util.PaginatedTable>
      )}
    </>
  );
}

function renderRegistrationsSection(
  registrations: RegistrationIssuesSnapshot,
  now: number,
  authorProjects: ReadonlyMap<string, AuthorProject>
): util.Child {
  return (
    <section
      id='registrations'
      data-checked-at={registrations.checkedAt !== undefined ? String(registrations.checkedAt) : ''}
    >
      {renderRegistrationsInner(registrations, now, authorProjects)}
    </section>
  );
}

function renderProjectsMeta(sub: db.SubmissionAdminSummary): util.Child {
  const tipParts: string[] = [
    `Last 24h: ${sub.submitted24h} ${sub.submitted24h === 1 ? 'submission' : 'submissions'}`,
    `${sub.smokeRuns24h} diagnostic ${sub.smokeRuns24h === 1 ? 'run' : 'runs'} ` +
      `(${sub.smokePassed24h} passed, ${sub.smokeFailed24h} failed` +
      `${sub.smokeDiscarded24h > 0 ? `, ${sub.smokeDiscarded24h} discarded` : ''}; ` +
      `${sub.diagnosticGames24h} ${sub.diagnosticGames24h === 1 ? 'game' : 'games'})`,
    `${sub.activated24h} activated`,
  ];
  if (sub.pendingCount > 0) tipParts.push(`${sub.pendingCount} pending`);
  if (sub.stagedCount > 0) tipParts.push(`${sub.stagedCount} staged`);
  tipParts.push(`${sub.totalActivated.toLocaleString('en-US')} activated all-time`);

  return (
    <span className='section-meta muted' title={tipParts.join(' · ')}>
      {sub.smokeRuns24h.toLocaleString('en-US')} {sub.smokeRuns24h === 1 ? 'run' : 'runs'}
      {sub.smokeFailed24h > 0 && ` (${sub.smokeFailed24h.toLocaleString('en-US')} fail)`}
      {' · '}
      {sub.activated24h.toLocaleString('en-US')} activated
    </span>
  );
}

export function renderAdminPage(opts: {
  snapshot: AdminSnapshot;
  allLadders: db.LadderRow[];
  liveTournament?: {id: string; name: string};
  authorProjects?: ReadonlyMap<string, AuthorProject>;
}): string {
  const {snapshot, allLadders, liveTournament} = opts;
  const ladderNameById = new Map(allLadders.map(l => [l.id, l.name]));
  const wipeableVersionIds = new Set(snapshot.wipeableVersionIds);
  const {pendingSubmissions, stagedCount, unsentDmCount, smokeCadence} = snapshot.health;
  const authorProjects = opts.authorProjects ?? buildAuthorProjectsFromAgents(snapshot.agents);

  const content = (
    <>
      <div id='admin-feedback' className='admin-feedback hide' role='status' />

      {renderSystemSection(snapshot.system, snapshot.generatedAt, {
        pendingQueue: pendingSubmissions.length,
        stagedCount,
        unsentDms: unsentDmCount,
        smokeCadence,
      })}
      {renderLaddersSection(snapshot.ladders, snapshot.matches24h, snapshot.totalMatches)}
      {renderRegistrationsSection(snapshot.registrations, snapshot.generatedAt, authorProjects)}

      <section id='projects'>
        <div className='section-head'>
          <h3>
            <a href='#projects' className='subtle'>
              Projects (<span id='projects-total'>{snapshot.totalAgents}</span>)
            </a>
          </h3>
          {renderProjectsMeta(snapshot.submissions)}
        </div>
        {snapshot.totalAgents === 0 ? (
          <p className='muted'>No Arena projects registered yet.</p>
        ) : (
          <util.PaginatedTable
            tbodyId='projects-tbody'
            head={(
              <tr>
                <th>Project</th>
                <th>Discord</th>
                <th>Ladders</th>
                <th>Eligibility</th>
                <th>Entered</th>
              </tr>
            )}
            pager={{
              id: 'projects-pager',
              label: 'Projects pagination',
              total: snapshot.totalAgents,
              singular: 'project',
              plural: 'projects',
              server: true,
            }}
          >
            {renderProjectRows(snapshot.agents, ladderNameById, wipeableVersionIds)}
          </util.PaginatedTable>
        )}
      </section>

      {renderWikiEditsSection(snapshot.wikiEdits, snapshot.totalWikiEdits)}

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
  const ownsVpsMonitor = !options.vpsMonitor;
  const vpsMonitor = options.vpsMonitor ?? new system.VpsHostMonitor({
    dbPath: db.dbPath,
    now: getNow,
  });

  const adminStreamClients = new Set<http.ServerResponse>();
  let lastBroadcastMs = 0;
  let pendingBroadcastTimer: ReturnType<typeof setTimeout> | undefined;

  const evictIfStalled = (client: http.ServerResponse): boolean => {
    if (client.writableEnded || client.destroyed) {
      adminStreamClients.delete(client);
      return true;
    }
    if (client.writableLength > MAX_SSE_BUFFER_BYTES) {
      adminStreamClients.delete(client);
      client.destroy();
      return true;
    }
    return false;
  };

  const keepaliveTimer = setInterval(() => {
    for (const client of adminStreamClients) {
      if (!evictIfStalled(client)) {
        client.write(': keepalive\n\n');
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
    const stagedCount = db.countStagedVersions();
    const unsentDms = db.getPendingVersionDms().length;
    const smokeCadence = db.getSmokeCadence();
    return {
      generatedAt: now,
      ...(sys.lastHeartbeatAt !== undefined ? {lastHeartbeatAt: sys.lastHeartbeatAt} : {}),
      runner,
      smokeCadence,
      vps: sys.vps,
      ...(sys.arena ? {arena: sys.arena} : {}),
      cardsHtml: renderSystemCards(sys, now, {
        pendingQueue,
        stagedCount,
        unsentDms,
        smokeCadence,
      }).toString(),
    };
  };

  const pushSystemEventNow = () => {
    if (adminStreamClients.size === 0) return;
    lastBroadcastMs = Date.now();
    let frame: string;
    try {
      frame = `event: system\ndata: ${JSON.stringify(buildSystemEventPayload(getNow()))}\n\n`;
    } catch (err) {
      console.error('Failed building /api/admin/stream payload:', err);
      return;
    }
    for (const client of adminStreamClients) {
      if (!evictIfStalled(client)) {
        client.write(frame);
      }
    }
  };

  const getRegistrationIssues = (): RegistrationIssuesSnapshot => {
    if (options.getRegistrationIssues) return options.getRegistrationIssues();
    if (options.registrationMonitor) return options.registrationMonitor.getSnapshot();
    return {issues: []};
  };

  const buildRegistrationsEventPayload = (
    now: number,
    registrations = getRegistrationIssues()
  ) => ({
    generatedAt: now,
    ...(registrations.checkedAt !== undefined ? {checkedAt: registrations.checkedAt} : {}),
    registrations,
    innerHtml: renderRegistrationsInner(
      registrations,
      now,
      buildAuthorProjectsFromDb(db)
    ).toString(),
  });

  const pushRegistrationsEventNow = () => {
    if (adminStreamClients.size === 0) return;
    let frame: string;
    try {
      const payload = buildRegistrationsEventPayload(getNow());
      frame = `event: registrations\ndata: ${JSON.stringify(payload)}\n\n`;
    } catch (err) {
      console.error('Failed building /api/admin/stream registrations payload:', err);
      return;
    }
    for (const client of adminStreamClients) {
      if (!evictIfStalled(client)) {
        client.write(frame);
      }
    }
  };

  const unsubscribeRegistrations = options.registrationMonitor?.onUpdate(pushRegistrationsEventNow);

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

  const serializeAdminAgentItem = (item: AdminAgentItem) => ({
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
      smokeDurationMillis: v.smokeDurationMillis,
      smokeInitMillis: v.smokeInitMillis,
      smokeTeamPreviewMillis: v.smokeTeamPreviewMillis,
      smokeTurnMillis: v.smokeTurnMillis,
      smokePeakRam: v.smokePeakRam,
      smokeInfoStatus: v.smokeInfoStatus,
      diagnostics: v.diagnostics,
      submittedAt: v.submittedAt,
      activatedAt: v.activatedAt,
      notified: v.notified,
      activeLadderNames: v.activeLadderNames,
      tournamentNames: v.tournamentNames,
    })),
  });

  const parseAdminPagination = (
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): {page: number; limit: number; offset: number} | undefined => {
    const parsedUrl = new URL(req.url ?? '/', 'http://localhost');
    const rawPage = parsedUrl.searchParams.get('page');
    const page = rawPage ? Number(rawPage) : 1;
    if (!Number.isSafeInteger(page) || page < 1 || page > 100_000) {
      sendJson(res, 400, {error: 'page must be an integer between 1 and 100000.'});
      return undefined;
    }
    const rawLimit = parsedUrl.searchParams.get('limit');
    const limit = rawLimit ? Number(rawLimit) : util.TABLE_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      sendJson(res, 400, {error: 'limit must be an integer between 1 and 100.'});
      return undefined;
    }
    return {page, limit, offset: (page - 1) * limit};
  };

  const handleGetAdmin = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    forceJson: boolean
  ) => {
    const wantsJson = forceJson || Boolean(req.headers.accept?.includes('application/json'));
    const login = requireAdmin(req, res, wantsJson);
    if (!login) return;

    const now = getNow();
    const sys = collectSystemSnapshot(now);
    const wikiEditsPage = options.wiki
      ? await options.wiki.getRecentEditsPage(util.TABLE_PAGE_SIZE, 0)
      : {edits: [], total: 0};
    const registrations = getRegistrationIssues();
    const snapshot = buildAdminSnapshot(
      db,
      login,
      arenaHandle,
      now,
      sys,
      wikiEditsPage,
      registrations,
      options.getDiscordRoleMembers?.()
    );
    if (wantsJson) {
      sendJson(res, 200, {
        ...snapshot,
        agents: snapshot.agents.map(serializeAdminAgentItem),
      });
      return;
    }

    const html = renderAdminPage({
      snapshot,
      allLadders: db.getLadders(),
      liveTournament: db.getRunningTournament(),
      authorProjects: buildAuthorProjectsFromDb(db),
    });
    sendHtml(res, 200, html);
  };

  app.get('/admin', (req, res) => handleGetAdmin(req, res, false));
  app.get('/admin.json', (req, res) => handleGetAdmin(req, res, true));
  app.get('/admin/index.json', (req, res) => handleGetAdmin(req, res, true));

  app.get('/api/admin/projects.json', (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const paging = parseAdminPagination(req, res);
    if (!paging) return;
    const {page, limit, offset} = paging;
    const {agents, total} = buildAdminAgentsPage(
      db,
      getNow(),
      limit,
      offset,
      undefined,
      options.getDiscordRoleMembers?.()
    );
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const ladderNameById = new Map(db.getLadders().map(l => [l.id, l.name]));
    const wipeableVersionIds = new Set(db.getWipeableVersionIds());
    sendJson(res, 200, {
      page,
      pageSize: limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      projects: agents.map(serializeAdminAgentItem),
      rowsHtml: renderProjectRows(agents, ladderNameById, wipeableVersionIds).toString(),
    });
  });

  app.get('/api/admin/wiki-edits.json', async (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    const paging = parseAdminPagination(req, res);
    if (!paging) return;
    const {page, limit, offset} = paging;
    const {edits, total} = options.wiki
      ? await options.wiki.getRecentEditsPage(limit, offset)
      : {edits: [], total: 0};
    const totalPages = Math.max(1, Math.ceil(total / limit));
    sendJson(res, 200, {
      page,
      pageSize: limit,
      total,
      totalPages,
      hasPrev: page > 1,
      hasNext: page < totalPages,
      edits,
      rowsHtml: renderWikiEditRows(edits).toString(),
    });
  });

  app.get('/api/admin/stream', (req, res) => {
    if (!requireAdmin(req, res, true)) return;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'private, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    const cleanup = () => {
      adminStreamClients.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    adminStreamClients.add(res);
    res.write(
      `event: system\ndata: ${JSON.stringify(buildSystemEventPayload(getNow()))}\n\n`
    );
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

  app.post('/api/admin/agents/:slug/smoke-limit', async (req, res) => {
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
    if (typeof body.unlimited !== 'boolean') {
      sendJson(res, 400, {error: 'Expected {unlimited: boolean}.'});
      return;
    }
    const now = getNow();
    try {
      const agent = db.setUnlimitedSmokeTests(slug, body.unlimited, now);
      sendJson(res, 200, {
        ok: true,
        agent,
        submissionStatus: db.computeAgentSubmissionStatus(agent.id, now),
      });
    } catch (err: any) {
      const status = /not found/i.test(String(err?.message)) ? 404 : 400;
      sendJson(res, status, {
        error: err?.message || 'Failed updating 3/24h diagnostic limit.',
      });
    }
  });

  const parsePositiveIntParam = (raw: string | string[] | undefined): number | undefined => {
    const val = Array.isArray(raw) ? raw[0] : raw;
    if (!val || !/^\d+$/.test(val)) return undefined;
    const n = Number(val);
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  };

  const resolveAdminDiagnostic = (
    req: http.IncomingMessage & {params: Record<string, string | string[] | undefined>},
    res: http.ServerResponse,
    missingLabel: string
  ): {diag: db.SmokeDiagnosticRow; agent: db.AgentRow} | undefined => {
    if (!requireAdmin(req, res, true)) return undefined;
    const id = parsePositiveIntParam(req.params.id);
    if (id === undefined) {
      sendJson(res, 400, {error: 'Invalid diagnostic ID.'});
      return undefined;
    }
    const diag = db.getSmokeDiagnosticById(id);
    if (!diag) {
      sendJson(res, 404, {error: `Diagnostic ${missingLabel} not found.`});
      return undefined;
    }
    const agent = db.getAgentById(diag.agentId);
    if (!agent) {
      sendJson(res, 404, {error: 'Project not found.'});
      return undefined;
    }
    return {diag, agent};
  };

  app.get('/api/admin/diagnostics/:id/log', (req, res) => {
    const resolved = resolveAdminDiagnostic(req, res, 'log');
    if (resolved) account.sendDiagnosticLogResponse(req, res, resolved.diag, resolved.agent);
  });

  app.get('/api/admin/diagnostics/:id/stderr', (req, res) => {
    const resolved = resolveAdminDiagnostic(req, res, 'stderr');
    if (resolved) account.sendDiagnosticStderrResponse(req, res, resolved.diag, resolved.agent);
  });

  app.post('/api/admin/versions/:id/discard', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const versionId = parsePositiveIntParam(req.params.id);
    if (versionId === undefined) {
      sendJson(res, 400, {error: 'Invalid version ID.'});
      return;
    }
    const ver = db.getVersionById(versionId);
    if (!ver) {
      sendJson(res, 404, {error: `Unknown versionId ${versionId}`});
      return;
    }
    try {
      const updated = db.discardStagedVersion({versionId, agentId: ver.agentId});
      const safe = {...updated};
      delete safe.authTokenEncoding;
      sendJson(res, 200, {ok: true, version: safe});
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      sendJson(res, status, {error: err?.message || 'Failed discarding staged version.'});
    }
  });

  app.post('/api/admin/agents/:slug/pools/:ladderId/wipe', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const slug = decodeParam(req.params.slug);
    const ladderId = decodeParam(req.params.ladderId);
    try {
      const result = db.wipeSavedTeams(slug, ladderId);
      sendJson(res, 200, {ok: true, ...result});
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      sendJson(res, status, {error: err?.message || 'Failed wiping saved teams.'});
    }
  });

  app.post('/api/admin/versions/:id/wipe', (req, res) => {
    if (!requireAdminMutation(req, res)) return;
    const versionId = parsePositiveIntParam(req.params.id);
    if (versionId === undefined) {
      sendJson(res, 400, {error: 'Invalid version ID.'});
      return;
    }
    const now = getNow();
    try {
      const result = db.wipeVersion(versionId, now);
      const safe = {...result.version};
      delete safe.authTokenEncoding;
      sendJson(res, 200, {ok: true, version: safe});
    } catch (err: any) {
      const status = typeof err?.status === 'number' ? err.status : 400;
      sendJson(res, status, {error: err?.message || 'Failed wiping version.'});
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
      const activePoolsIds = db
        .getLadders()
        .filter(l => l.team === 'pools' && l.status !== 'archived')
        .map(l => l.id);
      const result = db.quarantineVersion(slug, version, reason, now);
      const pubDir = options.publicDir ?? arena.PUBLIC_DIR;
      for (const id of activePoolsIds) {
        if (db.getLadder(id)?.status === 'archived') {
          arena.promoteArchivedPoolsLogs(pubDir, id);
        }
      }
      const safe = {...result.version};
      delete safe.authTokenEncoding;
      sendJson(res, 200, {ok: true, version: safe});
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
      const safe = {...updated};
      delete safe.authTokenEncoding;
      sendJson(res, 200, {ok: true, version: safe});
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
      const before = db.getLadder(ladderId);
      db.retireLadderEntry(ladderId, slug, version, now);
      if (before?.team === 'pools' && before.status !== 'archived') {
        const after = db.getLadder(ladderId);
        if (after?.status === 'archived') {
          arena.promoteArchivedPoolsLogs(options.publicDir ?? arena.PUBLIC_DIR, ladderId);
        }
      }
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
      unsubscribeRegistrations?.();
      if (ownsVpsMonitor) vpsMonitor.stop();
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
