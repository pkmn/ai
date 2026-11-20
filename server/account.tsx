import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as querystring from 'querystring';

import polka from 'polka';

import {SETTLED_MAX_SE, SETTLED_MIN_MATCHES, loadLadderPools} from '../db';
import type * as db from '../db';
import {header, injectLiveBanner, renderErrorPage, renderer} from '../static/build';
import {
  Child,
  Html,
  TABLE_PAGER_SCRIPT,
  TABLE_PAGE_SIZE,
  TablePager,
  VERSION_RE,
  formatUtcDate,
  formatUtcDateTime,
  installHeadSupport,
  readBody,
  root,
} from '../static/util';

import {Auth, isCrossSiteRequest} from './auth';
import {
  RejectedTeam,
  splitSubmittedTeams,
  validateCompetitorTeamsIncrementalForVersion,
} from './teams';

export function deducePackageFormat(url: string): db.PackageFormat {
  const cleanPath = url.split(/[?#]/)[0].toLowerCase();
  if (
    cleanPath.endsWith('.tar.gz') ||
    cleanPath.endsWith('.tgz') ||
    cleanPath.endsWith('.tar.xz') ||
    cleanPath.endsWith('.txz') ||
    cleanPath.endsWith('.tar.zst') ||
    cleanPath.endsWith('.tzst')
  ) {
    return 'bundle';
  }
  return 'oci';
}

// One-time private artifact pull tokens (e.g. scoped GitHub Release / R2 / GHCR headers) are
// encrypted at rest in SQLite with AES-256-GCM under an HKDF-derived subkey of `SESSION_SECRET`.
// The Mac mini runner decrypts the header once via `/api/arena/pending-submissions` and the server
// wipes `auth_token_encoding = NULL` as soon as `/api/arena/submission-status` reports back.
function deriveSecretKey(secret: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', secret, '', 'pkmn-arena-auth-token-v1', 32)
  );
}

export function encryptSecret(plaintext: string, secret: string): string {
  const key = deriveSecretKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptSecret(encoded: string, secret: string): string {
  const parts = encoded.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted secret format');
  const key = deriveSecretKey(secret);
  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid encrypted secret IV or authentication tag length');
  }
  const data = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {authTagLength: 16});
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const OCI_REF_RE = new RegExp(
  '^[A-Za-z0-9._-]+(?::\\d{1,5})?/[A-Za-z0-9._/-]+' +
  '(?::[A-Za-z0-9._-]+)?(?:@sha256:[0-9a-fA-F]{64})?$'
);
const MAX_SUBMISSION_BYTES = 512 * 1024;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_ATTEMPTS = 5;

const STYLE = fs.readFileSync(root('static', 'style', 'account.css'), 'utf8');

const ACCOUNT_SCRIPT = `
  document.addEventListener('DOMContentLoaded', () => {
    const unlinkBtn = document.getElementById('discord-unlink-btn');
    if (unlinkBtn) {
      unlinkBtn.addEventListener('click', async e => {
        e.preventDefault();
        const res = await fetch('/api/account/discord/unlink', {
          method: 'POST',
          headers: {Accept: 'application/json'},
        });
        if (res.ok) window.location.reload();
      });
    }

    const verInput = document.getElementById('sub-ver');
    const urlInput = document.getElementById('sub-url');
    const shaInput = document.getElementById('sub-sha');
    const typeSelect = document.getElementById('sub-type');
    const tourneyChecks = document.querySelectorAll('input[name="tournaments"]');
    const bundleOpt = typeSelect ? typeSelect.querySelector('option[value="bundle"]') : null;
    const form = document.getElementById('submission-form');
    const fieldset = form ? form.querySelector('.form-fieldset') : null;
    const submitBtn = document.getElementById('sub-btn');
    const teamFields = document.querySelectorAll('.pool-teams-field');
    const ladderChecks = document.querySelectorAll('input[name="ladders"]');
    const progressText = document.getElementById('pool-progress-text');
    const teamsArea = document.getElementById('sub-teams');
    let submitting = false;

    const getActivePoolCheckbox = () => {
      let found = null;
      ladderChecks.forEach(cb => {
        if (!found && cb.checked && cb.dataset.needsTeams === 'true') found = cb;
      });
      return found;
    };

    const syncSubmitBtn = () => {
      if (!submitBtn) return;
      if (!fieldset || fieldset.disabled || submitting) {
        submitBtn.disabled = true;
        return;
      }
      const hasVer = Boolean(verInput && verInput.value.trim());
      const hasUrl = Boolean(urlInput && urlInput.value.trim());
      const hasSha = Boolean(shaInput && shaInput.value.trim());
      let hasTarget = false;
      ladderChecks.forEach(cb => {
        if (cb.checked && !cb.disabled) hasTarget = true;
      });
      tourneyChecks.forEach(cb => {
        if (cb.checked && !cb.disabled) hasTarget = true;
      });
      const activeCb = getActivePoolCheckbox();
      let hasTeams = true;
      if (activeCb) {
        const saved = Number(activeCb.dataset.savedTeams || 0);
        const required = Number(activeCb.dataset.requiredTeams || 0);
        hasTeams = (required > 0 && saved >= required) ||
          Boolean(teamsArea && teamsArea.value.trim());
      }
      submitBtn.disabled = !(hasVer && hasUrl && hasSha && hasTarget && hasTeams);
    };

    const syncTourneyPackage = () => {
      if (!typeSelect) return;
      let anyTourney = false;
      tourneyChecks.forEach(cb => {
        if (cb.checked) anyTourney = true;
      });
      if (bundleOpt) bundleOpt.disabled = anyTourney;
      if (anyTourney) typeSelect.value = 'oci';
      syncSubmitBtn();
    };
    tourneyChecks.forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) {
        ladderChecks.forEach(lcb => {
          lcb.checked = false;
        });
        syncTeamsVisibility();
      }
      syncTourneyPackage();
    }));
    syncTourneyPackage();

    if (urlInput && typeSelect) {
      urlInput.addEventListener('input', () => {
        const v = urlInput.value.trim().split('?')[0].toLowerCase();
        if (v) {
          const isArchive = /\\.(tar\\.gz|tgz|tar\\.xz|txz|tar\\.zst|tzst)$/.test(v);
          if (isArchive && (!bundleOpt || !bundleOpt.disabled)) {
            typeSelect.value = 'bundle';
          } else if (!v.startsWith('http://') && !v.startsWith('https://') && v.includes('/')) {
            typeSelect.value = 'oci';
          }
        }
        syncSubmitBtn();
      });
    }
    if (verInput) verInput.addEventListener('input', syncSubmitBtn);
    if (shaInput) shaInput.addEventListener('input', syncSubmitBtn);
    if (teamsArea) teamsArea.addEventListener('input', syncSubmitBtn);

    const getFeedbackEl = () => {
      let el = document.getElementById('teams-feedback');
      if (!el) {
        const panel = document.getElementById('pool-teams-panel');
        if (!panel) return null;
        el = document.createElement('div');
        el.id = 'teams-feedback';
        el.className = 'teams-feedback hide';
        panel.appendChild(el);
      }
      return el;
    };

    const renderPoolProgress = (saved, required) => {
      const remaining = Math.max(0, required - saved);
      const pct = required > 0 ? Math.min(100, Math.round((saved / required) * 100)) : 0;
      const activeCb = getActivePoolCheckbox();
      if (activeCb) {
        activeCb.dataset.savedTeams = String(saved);
        const labelEl = activeCb.closest('label');
        if (labelEl) {
          let hintEl = labelEl.querySelector('.pool-status-hint');
          if (!hintEl) {
            hintEl = document.createElement('span');
            hintEl.className = 'muted pool-status-hint';
            labelEl.appendChild(hintEl);
          }
          const parts = [];
          if (activeCb.dataset.upcoming === 'true') parts.push('upcoming');
          if (saved > 0 && required > 0) parts.push(saved + '/' + required + ' saved');
          hintEl.textContent = parts.length ? ' (' + parts.join(' · ') + ')' : '';
        }
      }
      if (progressText) {
        progressText.textContent = '';
        const strong = document.createElement('strong');
        strong.textContent = saved + '/' + required;
        progressText.appendChild(strong);
        progressText.appendChild(document.createTextNode(' distinct teams saved'));
      }
      let fillEl = document.getElementById('pool-progress-fill');
      if (!fillEl) {
        const track = document.querySelector('.progress-track');
        if (track) {
          fillEl = document.createElement('div');
          fillEl.id = 'pool-progress-fill';
          fillEl.className = 'progress-fill';
          track.appendChild(fillEl);
        }
      }
      if (fillEl) {
        fillEl.style.width = pct + '%';
        fillEl.classList.toggle('complete', remaining === 0 && required > 0);
      }
      syncSubmitBtn();
    };

    const renderTeamsFeedback = (summary, rejections, isError) => {
      const box = getFeedbackEl();
      if (!box) return;
      box.classList.remove('hide');
      box.textContent = '';
      const summaryEl = document.createElement('div');
      summaryEl.id = 'teams-feedback-summary';
      summaryEl.className = isError ? 'no' : 'yes';
      summaryEl.textContent = summary;
      box.appendChild(summaryEl);
      if (Array.isArray(rejections) && rejections.length) {
        const listEl = document.createElement('ul');
        listEl.id = 'teams-rejections';
        listEl.className = 'teams-rejections';
        rejections.forEach(item => {
          const li = document.createElement('li');
          li.textContent = typeof item === 'string' ? item : item.reason;
          listEl.appendChild(li);
        });
        box.appendChild(listEl);
      }
    };

    const syncTeamsVisibility = () => {
      if (!teamFields.length) {
        syncSubmitBtn();
        return;
      }
      const activeCb = getActivePoolCheckbox();
      teamFields.forEach(el => el.classList.toggle('hide', !activeCb));
      if (activeCb) {
        renderPoolProgress(
          Number(activeCb.dataset.savedTeams || 0),
          Number(activeCb.dataset.requiredTeams || 0)
        );
      } else {
        syncSubmitBtn();
      }
    };
    ladderChecks.forEach(cb => cb.addEventListener('change', () => {
      if (cb.checked) {
        tourneyChecks.forEach(tcb => {
          tcb.checked = false;
        });
        syncTourneyPackage();
      }
      syncTeamsVisibility();
    }));
    syncTeamsVisibility();

    const getStatusEl = () => {
      let el = document.getElementById('sub-status');
      if (!el && form) {
        el = document.createElement('div');
        el.id = 'sub-status';
        el.className = 'hide';
        form.appendChild(el);
      }
      return el;
    };
    if (form && submitBtn) {
      form.addEventListener('submit', async e => {
        e.preventDefault();
        const statusEl = getStatusEl();
        if (!statusEl) return;
        const ladders = [];
        ladderChecks.forEach(cb => {
          if (cb.checked) ladders.push(cb.value);
        });
        const tournaments = [];
        tourneyChecks.forEach(cb => {
          if (cb.checked) tournaments.push(cb.value);
        });
        const payload = {
          version: verInput.value.trim(),
          package: typeSelect.value,
          url: urlInput.value.trim(),
          sha256: shaInput.value.trim(),
          authToken: document.getElementById('sub-auth').value.trim(),
          ladders,
          tournaments,
        };
        if (teamsArea && !teamsArea.closest('.hide') && teamsArea.value.trim()) {
          payload.teams = teamsArea.value;
        }
        submitting = true;
        syncSubmitBtn();
        statusEl.className = 'muted';
        statusEl.textContent = 'Validating submission...';
        try {
          const res = await fetch('/api/submissions', {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Accept: 'application/json'},
            body: JSON.stringify(payload),
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            if (typeof data.savedCount === 'number' && typeof data.requiredCount === 'number') {
              statusEl.className = 'hide';
              statusEl.textContent = '';
              renderPoolProgress(data.savedCount, data.requiredCount);
              const rej = Array.isArray(data.rejections) ? data.rejections : [];
              if (rej.length > 0) {
                renderTeamsFeedback(
                  'Saved ' + data.savedCount + '/' + data.requiredCount +
                    ' distinct teams — ' + rej.length + ' team(s) rejected:',
                  rej,
                  true
                );
              } else {
                if (teamsArea) teamsArea.value = '';
                renderTeamsFeedback(
                  data.error ||
                    ('Saved ' + data.savedCount + '/' + data.requiredCount + ' distinct teams.'),
                  [],
                  true
                );
              }
            } else {
              statusEl.className = 'no';
              statusEl.textContent = data.error || ('Submission failed (' + res.status + ')');
            }
            submitting = false;
            syncSubmitBtn();
            return;
          }
          window.location.reload();
        } catch {
          statusEl.className = 'no';
          statusEl.textContent = 'Network error submitting version.';
          submitting = false;
          syncSubmitBtn();
        }
      });
    }

    ${TABLE_PAGER_SCRIPT}
  });
`;

export interface Options {
  db: db.Database;
  auth: Auth;
  poolsByLadder?: Map<string, string[]>;
  rateLimitMaxAttempts?: number;
  now?: () => number;
}

function sendHtml(res: http.ServerResponse, status: number, html: string) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-store',
  });
  res.end(html);
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: object,
  extraHeaders?: http.OutgoingHttpHeaders
) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function redirect(res: http.ServerResponse, location: string, status = 302) {
  res.writeHead(status, {
    Location: location,
    'Cache-Control': 'private, no-store',
  });
  res.end();
}

function renderActiveSection(entries: db.ActiveEntryView[]): Html {
  if (!entries.length) {
    return (
      <section id='active'>
        <h3><a href='#active' className='subtle'>Active</a></h3>
        <p className='muted'>No active versions on any ladder yet.</p>
      </section>
    );
  }

  return (
    <section id='active'>
      <h3><a href='#active' className='subtle'>Active</a></h3>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Ladder</th>
              <th>Version</th>
              <th className='num'>Rank</th>
              <th className='num'>Elo</th>
              <th className='num'>W–L–T</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(e => {
              const isChampion = e.role === 'champion';
              const w = e.ww + e.wt;
              const l = e.ll + e.tl;
              const t = e.split;
              const elo = Math.round(e.elo);
              const ci = Math.round(1.96 * e.se);
              const settled = e.settledAt !== undefined || (
                e.se <= SETTLED_MAX_SE && e.matches >= SETTLED_MIN_MATCHES
              );

              if (isChampion) {
                return (
                  <tr>
                    <td><tt>{e.ladderName}</tt></td>
                    <td><code><strong>{e.version}</strong></code></td>
                    <td className='num'>
                      {e.rankCurrent !== undefined
                        ? <strong>#{e.rankCurrent}</strong>
                        : <span className='muted'>—</span>}
                    </td>
                    <td className='num'>
                      <strong>{elo}</strong>
                      {!e.isAnchor && <> <span className='muted'>±{ci}</span></>}
                    </td>
                    <td className='num'>{w}–{l}–{t}</td>
                    <td>
                      {settled
                        ? <span className='yes'>Settled</span>
                        : <span className='muted'>Provisional</span>}
                    </td>
                  </tr>
                );
              }

              return (
                <tr className='secondary'>
                  <td><tt>{e.ladderName}</tt></td>
                  <td><code>{e.version}</code></td>
                  <td className='num muted'>—</td>
                  <td className='num'>
                    {elo}
                    {!e.isAnchor && <> <span className='muted'>±{ci}</span></>}
                  </td>
                  <td className='num'>{w}–{l}–{t}</td>
                  <td>{settled ? 'Settled' : 'Provisional'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function renderHistorySection(
  versions: db.VersionHistoryView[],
  ladderNameById: Map<string, string>
): Html {
  if (!versions.length) {
    return (
      <section id='history'>
        <h3><a href='#history' className='subtle'>History</a></h3>
        <p className='muted'>No versions submitted yet.</p>
      </section>
    );
  }

  return (
    <section id='history'>
      <h3><a href='#history' className='subtle'>History</a></h3>
      <div className='table-wrap'>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Ladders</th>
              <th>Artifact</th>
              <th>Smoke Test</th>
              <th>State</th>
              <th className='num'>Submitted</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v, idx) => {
              const ladderLabels: Child[] = v.ladders.map(id => ladderNameById.get(id) ?? id);
              const tourneyLabels: Child[] = (v.tournamentNames ?? []).map(name => {
                const m = /^Tournament #(\d+)/.exec(name);
                return m ? <span title={name}>T#{m[1]}</span> : name;
              });
              const allLabels = [...ladderLabels, ...tourneyLabels];
              const laddersContent = allLabels.map((item, i) => (i === 0 ? item : [', ', item]));

              const shortSha = `sha256:${v.sha256.slice(0, 4)}…${v.sha256.slice(-4)}`;
              const sizeMib = v.unpackedBytes !== undefined
                ? Math.max(1, Math.round(v.unpackedBytes / (1024 * 1024)))
                : undefined;

              const isTournamentOnly =
                ladderLabels.length === 0 && (v.tournamentNames?.length ?? 0) > 0;
              const isFullyActive = v.smokeStatus === 'passed' && (
                isTournamentOnly || (
                  v.activeLadderNames.length > 0 &&
                  v.activeLadderNames.length >= ladderLabels.length
                )
              );
              const isPartiallyActive = !isTournamentOnly &&
                v.smokeStatus === 'passed' &&
                v.activeLadderNames.length > 0 &&
                v.activeLadderNames.length < ladderLabels.length;
              const isRetired = !isTournamentOnly &&
                v.smokeStatus === 'passed' &&
                v.activeLadderNames.length === 0;

              let smokeCell: Child;
              if (v.smokeStatus === 'pending') {
                smokeCell = <span className='muted'>PENDING</span>;
              } else if (v.smokeStatus === 'passed') {
                const statsParts: string[] = [];
                if (v.smokeDurationMillis !== undefined) {
                  statsParts.push(`${(v.smokeDurationMillis / 1000).toFixed(1)}s`);
                }
                if (v.smokeInitMillis !== undefined) {
                  statsParts.push(`${v.smokeInitMillis}ms init`);
                }
                if (v.smokeTeamPreviewMillis !== undefined) {
                  statsParts.push(`${v.smokeTeamPreviewMillis}ms team`);
                }
                if (v.smokeTurnMillis !== undefined) {
                  statsParts.push(`${v.smokeTurnMillis}ms/turn`);
                }
                if (v.smokePeakRam !== undefined) {
                  statsParts.push(`${v.smokePeakRam.toLocaleString('en-US')} MiB`);
                }
                smokeCell = (
                  <>
                    {isRetired ? <span>PASS</span> : <span className='yes'>PASS</span>}
                    {statsParts.length > 0 && (
                      <> <span className='muted'>({statsParts.join(' · ')})</span></>
                    )}
                  </>
                );
              } else {
                const label = v.smokeStatus === 'quarantined' ? 'QUARANTINED' : 'FAIL';
                smokeCell = (
                  <>
                    <span className='no'>{label}</span>
                    {Boolean(v.notified) && <> <span className='muted'>(DM sent)</span></>}
                    {v.smokeError && (
                      <details className='smoke-log'>
                        <summary>Sandbox <tt>stderr</tt> log</summary>
                        <pre><code>{v.smokeError}</code></pre>
                      </details>
                    )}
                  </>
                );
              }

              let stateCell: Child;
              if (v.smokeStatus === 'pending') {
                stateCell = <span className='muted'>Pending</span>;
              } else if (v.smokeStatus === 'failed') {
                stateCell = <span className='muted'>Rejected</span>;
              } else if (v.smokeStatus === 'quarantined') {
                stateCell = <span className='no'>Quarantined</span>;
              } else if (isFullyActive) {
                stateCell = isTournamentOnly
                  ? <span className='yes'>Entered</span>
                  : <span className='yes'>Active</span>;
              } else if (isPartiallyActive) {
                stateCell = (
                  <>Active <span className='muted'>({v.activeLadderNames.join(', ')})</span></>
                );
              } else {
                stateCell = <span className='muted'>Retired</span>;
              }

              const classes: string[] = [];
              if (isRetired) classes.push('secondary');
              if (idx >= TABLE_PAGE_SIZE) classes.push('hide');

              return (
                <tr className={classes.length > 0 ? classes.join(' ') : undefined}>
                  <td>
                    {isFullyActive
                      ? <code><strong>{v.version}</strong></code>
                      : <code>{v.version}</code>}
                  </td>
                  <td><tt>{laddersContent}</tt></td>
                  <td>
                    <tt>{shortSha}</tt>
                    {sizeMib !== undefined && (
                      <> <span className='muted'>({sizeMib} MiB)</span></>
                    )}
                  </td>
                  <td>{smokeCell}</td>
                  <td>{stateCell}</td>
                  <td className='num muted'>{formatUtcDate(v.submittedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <TablePager
        id='history-pager'
        label='Version history pagination'
        total={versions.length}
        singular='version'
        plural='versions'
      />
    </section>
  );
}

export function renderAccountPage(opts: {
  developer: db.DeveloperRow;
  agent: db.AgentRow;
  status: db.SubmissionStatus;
  tournamentStatuses?: db.TournamentSubmissionStatus[];
  currentLadders: db.LadderRow[];
  needsTeamsLadders: db.LadderRow[];
  savedTeamsByLadder?: Map<string, number>;
  activeEntries: db.ActiveEntryView[];
  versions: db.VersionHistoryView[];
  allLadders: db.LadderRow[];
  liveTournament?: {id: string; name: string};
  now?: number;
}): string {
  const {
    developer,
    agent,
    status,
    tournamentStatuses = [],
    currentLadders,
    needsTeamsLadders,
    savedTeamsByLadder = new Map<string, number>(),
    activeEntries,
    versions,
    allLadders,
    liveTournament,
    now = Math.floor(Date.now() / 1000),
  } = opts;

  const linkHref = '/auth/discord?intent=link&return_to=%2Faccount%2F';
  const discordView = developer.discordUsername ? (
    <span id='discord-view'>
      <tt id='discord-val'>@{developer.discordUsername}</tt>{' '}
      <span className='muted'>
        (<a href={linkHref}>change</a> /{' '}
        <a href='#account' id='discord-unlink-btn'>unlink</a>)
      </span>
    </span>
  ) : (
    <span id='discord-view'>
      <span className='muted' id='discord-val'>None</span>{' '}
      <span className='muted'>(<a href={linkHref}>link</a>)</span>
    </span>
  );

  const projectHref = `/projects/${encodeURIComponent(agent.slug)}/`;

  // 'pending' projects cannot submit to continuous ladders (`status.canSubmit === false`), but are
  // intentionally allowed to enter scheduled tournaments (`canSubmitTourney === true`).
  const canSubmitTourney = tournamentStatuses.some(t => t.canSubmit);
  const canSubmitAny = status.canSubmit || canSubmitTourney;

  const statusClass = status.label === 'Eligible'
    ? 'yes'
    : status.label === 'Ineligible' ? 'no' : 'muted';
  const statusTitle =
    status.reason ?? 'Submission status: Pending / Qualified / Eligible / Ineligible';

  const needsTeamsIds = new Set(needsTeamsLadders.map(l => l.id));
  const activeLadderIdsWithAgent = new Set(activeEntries.map(e => e.ladderId));

  const firstPoolLadder = needsTeamsLadders[0];
  let poolTeamsRow: Child = undefined;
  if (firstPoolLadder?.teams && status.canSubmit) {
    const count = firstPoolLadder.teams;
    const saved = savedTeamsByLadder.get(firstPoolLadder.id) ?? 0;
    const remaining = Math.max(0, count - saved);
    const pct = count > 0 ? Math.min(100, Math.round((saved / count) * 100)) : 0;
    const placeholder =
      `Paste up to ${count} teams (one packed team per line or exportable with ` +
      '"=== [format] Team Name ===" separators). Valid distinct teams will be saved ' +
      'immediately upon upload and are locked for the season once your build passes.';
    poolTeamsRow = (
      <>
        <label htmlFor='sub-teams' className='pool-teams-field hide'>
          Teams<span className='req'>*</span>
        </label>
        <div className='pool-teams-field hide' id='pool-teams-panel'>
          <div className='teams-progress' id='pool-progress-box'>
            <div className='teams-progress-head'>
              <span id='pool-progress-text'>
                <strong>{saved}/{count}</strong> distinct teams saved
              </span>
            </div>
            <div className='progress-track'>
              <div
                className={
                  remaining === 0 && count > 0 ? 'progress-fill complete' : 'progress-fill'
                }
                id='pool-progress-fill'
                style={{width: `${pct}%`}}
              />
            </div>
          </div>
          <textarea
            id='sub-teams'
            name='teams'
            className='input-text'
            spellcheck={false}
            placeholder={placeholder}
          />
          <div id='teams-feedback' className='teams-feedback hide'>
            <div id='teams-feedback-summary' />
            <ul id='teams-rejections' className='teams-rejections' />
          </div>
        </div>
      </>
    );
  }

  let statusNotice: Html = <div id='sub-status' className='hide' />;
  if (!canSubmitAny && status.reason) {
    statusNotice = <div id='sub-status' className='muted'>{status.reason}</div>;
  } else if (!status.canSubmit && canSubmitTourney && status.reason) {
    statusNotice = (
      <div id='sub-status' className='muted'>
        Ladders: {status.reason} Tournament registration remains open above (1 OCI entry per
        project).
      </div>
    );
  }

  const ladderNameById = new Map(allLadders.map(l => [l.id, l.name]));
  const content = (
    <>
      <div className='account-bar' id='account'>
        <span>
          <span className='muted'>Developer:</span>{' '}
          <a
            href={`https://github.com/${encodeURIComponent(developer.githubLogin)}`}
            className='subtle'
          >
            <strong>{developer.githubLogin}</strong>
          </a>
        </span>
        <span className='muted'>·</span>
        <span><span className='muted'>Discord:</span> {discordView}</span>
        <span className='muted'>·</span>
        <span>
          <span className='muted'>Project:</span>{' '}
          <a href={projectHref} className='subtle'><strong>{agent.name}</strong></a>
        </span>
        <span className='muted'>·</span>
        <span>
          <span className='muted'>Status:</span>{' '}
          <span className={statusClass} title={statusTitle}>{status.label}</span>
        </span>
        <span className='muted'>·</span>
        <form method='POST' action='/auth/logout?return_to=%2Farena%2F' className='inline-form'>
          <button type='submit' className='link-btn'>Logout</button>
        </form>
      </div>

      {renderActiveSection(activeEntries)}

      <section id='submission'>
        <h3><a href='#submission' className='subtle'>Submission</a></h3>
        <form
          id='submission-form'
          className={canSubmitAny ? 'form-box' : 'form-box form-disabled'}
          method='POST'
          action='/api/submissions'
        >
          <fieldset className='form-fieldset' disabled={!canSubmitAny}>
            <div className='form-grid'>
              <label htmlFor='sub-ver'>Version<span className='req'>*</span></label>
              <div className='form-row-inline'>
                <input
                  id='sub-ver'
                  name='version'
                  className='input-text input-short'
                  type='text'
                  maxLength={12}
                  pattern='[A-Za-z0-9][A-Za-z0-9._\-]{0,11}'
                  placeholder='1.0.0'
                  required={true}
                />
                <label htmlFor='sub-type'>Package</label>
                <select id='sub-type' name='package' className='min-select'>
                  <option value='bundle' selected={true}>darwin/arm64 (.tar.zst)</option>
                  <option value='oci'>OCI image</option>
                </select>
              </div>

              <label htmlFor='sub-url'>Artifact URL<span className='req'>*</span></label>
              <input
                id='sub-url'
                name='url'
                className='input-text'
                type='text'
                spellcheck={false}
                placeholder='https://.../agent-darwin-arm64.tar.zst or ghcr.io/org/agent:1.0.0'
                required={true}
              />

              <label htmlFor='sub-sha'>SHA-256<span className='req'>*</span></label>
              <input
                id='sub-sha'
                name='sha256'
                className='input-text'
                type='text'
                spellcheck={false}
                placeholder='64-character hex archive or OCI manifest digest'
                required={true}
              />

              <label htmlFor='sub-auth'>Auth Header</label>
              <input
                id='sub-auth'
                name='authToken'
                className='input-text'
                type='password'
                autocomplete='off'
                placeholder={
                  'One-time header for private releases (scrubbed immediately after fetch)'
                }
              />

              {poolTeamsRow}

              <label>Target<span className='req'>*</span></label>
              <div className='target-group'>
                {tournamentStatuses.length > 0 && (
                  <div className='check-group'>
                    {tournamentStatuses.map(t => {
                      const scheduleHint =
                        `starts ${formatUtcDate(t.startsAt)} · ` +
                        `entries close ${formatUtcDateTime(t.closesAt)}`;
                      if (t.canSubmit) {
                        const checked = !status.canSubmit && tournamentStatuses.length === 1;
                        return (
                          <label title={`OCI image required (linux/amd64); ${scheduleHint}`}>
                            <input
                              type='checkbox'
                              name='tournaments'
                              value={t.tournamentId}
                              checked={checked}
                            />{' '}
                            {t.name}{' '}
                            <span className='muted'>
                              (OCI · closes {formatUtcDateTime(t.closesAt)})
                            </span>
                          </label>
                        );
                      }
                      const badge = t.enteredVersion
                        ? `entered: ${t.enteredVersion}`
                        : t.pendingVersion
                          ? `pending: ${t.pendingVersion}`
                          : now >= t.closesAt
                            ? 'entries closed'
                            : 'closed';
                      return (
                        <label className='upcoming' title={t.reason}>
                          <input
                            type='checkbox'
                            name='tournaments'
                            value={t.tournamentId}
                            disabled={true}
                          />{' '}
                          {t.name} <span className='muted'>({badge})</span>
                        </label>
                      );
                    })}
                  </div>
                )}

                <div className='ladders-submit-row'>
                  <div className='check-group'>
                    {currentLadders.length === 0 ? ' ' : currentLadders.map(l => {
                      const isOpen = l.status === 'upcoming' || l.status === 'active';
                      const canCheck = isOpen && status.canSubmit;
                      const checked = canCheck && activeLadderIdsWithAgent.has(l.id);
                      const needsTeams = needsTeamsIds.has(l.id);
                      const savedCount = savedTeamsByLadder.get(l.id) ?? 0;
                      const requiredCount = l.teams ?? 0;
                      let labelClass: string | undefined;
                      let labelTitle: string | undefined;
                      if (!isOpen) {
                        labelClass = 'upcoming';
                        labelTitle = 'Not open for submissions';
                      } else if (!status.canSubmit) {
                        labelClass = 'upcoming';
                        labelTitle = status.reason ?? 'Not currently eligible for ladders';
                      } else if (l.status === 'upcoming') {
                        labelTitle =
                          'Upcoming — accepting initial entries before matchmaking begins';
                      }
                      const statusParts: string[] = [];
                      if (l.status === 'upcoming') statusParts.push('upcoming');
                      if (needsTeams && requiredCount > 0 && savedCount > 0) {
                        statusParts.push(`${savedCount}/${requiredCount} saved`);
                      }
                      const hintText = statusParts.length ? ` (${statusParts.join(' · ')})` : '';
                      return (
                        <label className={labelClass} title={labelTitle}>
                          <input
                            type='checkbox'
                            name='ladders'
                            value={l.id}
                            checked={checked}
                            disabled={!canCheck}
                            data-needs-teams={canCheck && needsTeams ? 'true' : undefined}
                            data-required-teams={canCheck && needsTeams ? requiredCount : undefined}
                            data-saved-teams={canCheck && needsTeams ? savedCount : undefined}
                            data-ladder-name={canCheck && needsTeams ? l.name : undefined}
                            data-upcoming={
                              canCheck && needsTeams
                                ? (l.status === 'upcoming' ? 'true' : 'false')
                                : undefined
                            }
                          />{' '}
                          {l.name}
                          {needsTeams ? (
                            <span className='muted pool-status-hint'>{hintText}</span>
                          ) : (
                            hintText && <span className='muted'>{hintText}</span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                  <button
                    id='sub-btn'
                    type='submit'
                    className='btn'
                    disabled={true}
                    title={!canSubmitAny && status.reason ? status.reason : undefined}
                  >
                    Submit
                  </button>
                </div>
              </div>
            </div>
          </fieldset>
          {statusNotice}
        </form>
      </section>

      {renderHistorySection(versions, ladderNameById)}

      <script>{ACCOUNT_SCRIPT}</script>
    </>
  );

  return renderer.render({
    id: 'account-page',
    title: 'Account | pkmn.ai',
    header: injectLiveBanner(header('Account'), liveTournament),
    path: '/account/',
    style: STYLE,
    content,
  }, s => s.replace('</title>', '</title><meta name="robots" content="noindex">'));
}

function parseSubmissionPayload(
  rawBody: string,
  contentType: string | undefined
): {
  version: string;
  packageFormat?: string;
  url: string;
  sha256: string;
  authToken: string;
  ladders: string[];
  tournaments: string[];
  teams?: string | string[];
} {
  const parseList = (rawVal: unknown): string[] => {
    if (Array.isArray(rawVal)) {
      return rawVal.map(v => String(v ?? '').trim()).filter(Boolean);
    }
    return typeof rawVal === 'string' && rawVal.trim() ? [rawVal.trim()] : [];
  };

  if (contentType?.includes('application/json')) {
    const json = JSON.parse(rawBody || '{}') as Record<string, unknown>;
    const rawTeams = json.teams;
    const teams = Array.isArray(rawTeams)
      ? rawTeams.map(String)
      : typeof rawTeams === 'string' ? rawTeams : undefined;
    return {
      version: typeof json.version === 'string' ? json.version.trim() : '',
      packageFormat: typeof json.package === 'string' ? json.package.trim() : undefined,
      url: typeof json.url === 'string' ? json.url.trim() : '',
      sha256: typeof json.sha256 === 'string' ? json.sha256.trim() : '',
      authToken: typeof json.authToken === 'string' ? json.authToken.trim() : '',
      ladders: parseList(json.ladders),
      tournaments: parseList(json.tournaments),
      teams,
    };
  }

  const parsed = querystring.parse(rawBody);
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? v[0] : v ?? '').trim();

  return {
    version: str(parsed.version),
    packageFormat: str(parsed.package) || undefined,
    url: str(parsed.url),
    sha256: str(parsed.sha256),
    authToken: str(parsed.authToken),
    ladders: parseList(parsed.ladders),
    tournaments: parseList(parsed.tournaments),
    teams: parsed.teams !== undefined ? str(parsed.teams) : undefined,
  };
}

// Strict allowlists of public artifact hosts and container registries (matching `static/rules.dj`).
// Allowlisting known providers eliminates raw IP literals, arbitrary ports, DNS rebinding, and
// attacker-controlled redirect/tarpit origins without complex IPv4/IPv6 CIDR munging.
const ALLOWED_BUNDLE_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'huggingface.co',
  's3.amazonaws.com',
  'storage.googleapis.com',
]);

const ALLOWED_BUNDLE_HOST_RES = [
  /^[a-z0-9-]+\.hf\.co$/,
  /^[a-z0-9.-]+\.r2\.cloudflarestorage\.com$/,
  /^[a-z0-9-]+\.r2\.dev$/,
  /^(?:[a-z0-9.-]+\.)?s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/,
  /^[a-z0-9.-]+\.storage\.googleapis\.com$/,
  /^[a-z0-9.-]+\.backblazeb2\.com$/,
];

const ALLOWED_OCI_HOSTS = new Set([
  'ghcr.io',
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
  'quay.io',
  'gcr.io',
  'public.ecr.aws',
]);

const ALLOWED_OCI_HOST_RES = [
  /^[a-z0-9-]+\.gcr\.io$/,
  /^[a-z0-9-]+-docker\.pkg\.dev$/,
  /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com$/,
];

export function isAllowedBundleHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || host.startsWith('[') || host.endsWith('.')) return false;
  return ALLOWED_BUNDLE_HOSTS.has(host) || ALLOWED_BUNDLE_HOST_RES.some(re => re.test(host));
}

export function isAllowedOciRegistryHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host || host.startsWith('[') || host.endsWith('.')) return false;
  return ALLOWED_OCI_HOSTS.has(host) || ALLOWED_OCI_HOST_RES.some(re => re.test(host));
}

export function validateArtifactUrl(
  url: string,
  packageFormat: db.PackageFormat,
  allowPrivateUrls = false
): string | undefined {
  if (!url || /\s/.test(url)) {
    return 'Artifact URL must not be empty or contain whitespace.';
  }
  const deduced = deducePackageFormat(url);
  if (deduced !== packageFormat) {
    return packageFormat === 'bundle'
      ? 'Bundle Artifact URL must end in .tar.gz, .tgz, .tar.xz, .txz, .tar.zst, or .tzst.'
      : 'OCI image reference must not point to a .tar.{gz,xz,zst} archive.';
  }
  if (packageFormat === 'bundle') {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Bundle Artifact URL must be a valid URL.';
    }
    if (parsed.username || parsed.password) {
      return 'Bundle Artifact URL must not embed credentials.';
    }
    const allowHttp = allowPrivateUrls && process.env.NODE_ENV !== 'production';
    if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
      return 'Bundle Artifact URL must use HTTPS.';
    }
    if (!allowPrivateUrls && (parsed.port !== '' || !isAllowedBundleHost(parsed.hostname))) {
      return (
        'Bundle Artifact URL must be hosted on GitHub, Hugging Face, Cloudflare R2, ' +
        'AWS S3, GCS, or Backblaze B2.'
      );
    }
    return undefined;
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    return (
      'OCI image reference must be a registry reference ' +
      '(e.g. ghcr.io/org/agent:1.0.0), not an HTTP URL.'
    );
  }
  if (!OCI_REF_RE.test(url) || !url.includes('/')) {
    return 'Invalid OCI image reference (expected e.g. ghcr.io/org/agent:1.0.0).';
  }
  const slash = url.indexOf('/');
  const authority = url.slice(0, slash);
  let parsedAuthority: URL;
  try {
    parsedAuthority = new URL(`https://${authority}`);
  } catch {
    return 'Invalid OCI image reference (expected e.g. ghcr.io/org/agent:1.0.0).';
  }
  const registryHost = parsedAuthority.hostname;
  const isExplicitRegistry =
    authority.includes('.') ||
    authority.includes(':') ||
    authority.toLowerCase() === 'localhost' ||
    registryHost !== authority.toLowerCase();
  if (
    !allowPrivateUrls &&
    isExplicitRegistry &&
    (parsedAuthority.port !== '' || !isAllowedOciRegistryHost(registryHost))
  ) {
    return (
      'OCI image registry must be GHCR, Docker Hub, Quay, Google Artifact Registry/GCR, or AWS ECR.'
    );
  }
  return undefined;
}

export function register(app: polka.Polka, options: Options) {
  installHeadSupport(app);
  const {db, auth} = options;
  const getNow = options.now ?? (() => Math.floor(Date.now() / 1000));
  const getPools = () => options.poolsByLadder ?? loadLadderPools();
  const maxAttempts = options.rateLimitMaxAttempts ?? RATE_LIMIT_MAX_ATTEMPTS;
  const windowSeconds = RATE_LIMIT_WINDOW_SECONDS;
  const attemptsByAgent = new Map<number, number[]>();

  // Enforced before body parsing and 1-NN team-uniqueness checks so a logged-in developer cannot
  // exhaust CPU by spamming 20-team validation pastes (supplements Nginx's IP-based `submission`
  // zone when multiple co-authors submit for the same project).
  const checkSubmissionRateLimit = (agentId: number, now: number): number | undefined => {
    const cutoff = now - windowSeconds;
    const recent = (attemptsByAgent.get(agentId) ?? []).filter(ts => ts > cutoff);
    if (recent.length >= maxAttempts) {
      attemptsByAgent.set(agentId, recent);
      return Math.max(1, recent[0] + windowSeconds - now);
    }
    recent.push(now);
    attemptsByAgent.set(agentId, recent);
    return undefined;
  };

  const handleGetAccount = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    forceJson: boolean
  ) => {
    const wantsJson = forceJson || Boolean(req.headers.accept?.includes('application/json'));
    const login = auth.getGitHubUser(req);
    if (!login) {
      if (wantsJson) {
        sendJson(res, 401, {error: 'GitHub authentication required.'});
      } else {
        redirect(res, '/auth/github?return_to=%2Faccount%2F');
      }
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const agent = developer ? db.getAgentById(developer.agentId) : undefined;
    const liveTournament = db.getRunningTournament();
    if (!developer || !agent || agent.status === 'disabled') {
      if (wantsJson) {
        sendJson(res, 403, {
          error: `GitHub account "${login}" is not registered to an approved Arena project.`,
        });
      } else {
        sendHtml(res, 403, renderErrorPage(403, liveTournament));
      }
      return;
    }

    const now = getNow();
    const status = db.computeAgentSubmissionStatus(agent.id, now);
    const tournamentStatuses = db.computeAgentTournamentStatuses(agent.id, now);
    const currentLadders = db.getCurrentLadders();
    const needsTeamsLadders = currentLadders.filter(
      l => (l.status === 'upcoming' || l.status === 'active') &&
        l.team === 'pools' &&
        !db.hasActiveLadderTeams(l.id, agent.id)
    );
    const savedTeamsByLadder = new Map<string, number>();
    const savedTeamsJson: Record<string, {
      savedCount: number;
      requiredCount: number;
      remainingCount: number;
      complete: boolean;
      locked: boolean;
    }> = {};
    for (const l of currentLadders) {
      if (l.team !== 'pools' || !l.teams) continue;
      const locked = db.hasActiveLadderTeams(l.id, agent.id);
      const savedCount = locked
        ? l.teams
        : db.getTeamsForAgentLadder(l.id, agent.id, 'saved').length;
      if (!locked) savedTeamsByLadder.set(l.id, savedCount);
      const remainingCount = locked ? 0 : Math.max(0, l.teams - savedCount);
      savedTeamsJson[l.id] = {
        savedCount,
        requiredCount: l.teams,
        remainingCount,
        complete: remainingCount === 0,
        locked,
      };
    }
    const activeEntries = db.getActiveEntriesForAgent(agent.id);
    const versions = db.getVersionsForAgent(agent.id);

    if (wantsJson) {
      const needsTeamsIds = new Set(needsTeamsLadders.map(l => l.id));
      sendJson(res, 200, {
        developer: {
          github: developer.githubLogin,
          smogon: developer.smogonUsername,
          smogonId: developer.smogonId,
          discordId: developer.discordId,
          discordUsername: developer.discordUsername,
        },
        agent: {
          slug: agent.slug,
          name: agent.name,
          status: agent.status,
          profileHref: `/projects/${encodeURIComponent(agent.slug)}/`,
        },
        submissionStatus: status,
        tournamentStatuses,
        savedTeams: savedTeamsJson,
        currentLadders: currentLadders.map(l => ({
          id: l.id,
          slot: l.slot,
          name: l.name,
          format: l.format,
          team: l.team,
          teams: l.teams,
          status: l.status,
          needsTeams: needsTeamsIds.has(l.id),
          savedCount: savedTeamsJson[l.id]?.savedCount ?? 0,
          remainingTeams: savedTeamsJson[l.id]?.remainingCount ?? 0,
        })),
        activeEntries,
        versions: versions.map(v => ({
          id: v.id,
          version: v.version,
          package: v.package,
          sha256: v.sha256,
          ladders: v.ladders,
          tournaments: v.tournaments,
          unpackedBytes: v.unpackedBytes,
          smoke: {
            status: v.smokeStatus,
            durationMillis: v.smokeDurationMillis,
            initMillis: v.smokeInitMillis,
            teamPreviewMillis: v.smokeTeamPreviewMillis,
            turnMillis: v.smokeTurnMillis,
            peakRam: v.smokePeakRam,
            error: v.smokeError,
          },
          submittedAt: v.submittedAt,
          activatedAt: v.activatedAt,
          activeLadderNames: v.activeLadderNames,
          tournamentNames: v.tournamentNames,
        })),
      });
      return;
    }

    const html = renderAccountPage({
      developer,
      agent,
      status,
      tournamentStatuses,
      currentLadders,
      needsTeamsLadders,
      savedTeamsByLadder,
      activeEntries,
      versions,
      allLadders: db.getLadders(),
      liveTournament,
      now,
    });
    sendHtml(res, 200, html);
  };

  app.get('/account', (req, res) => handleGetAccount(req, res, false));
  app.get('/account.json', (req, res) => handleGetAccount(req, res, true));
  app.get('/account/index.json', (req, res) => handleGetAccount(req, res, true));

  app.post('/api/submissions', async (req, res) => {
    if (isCrossSiteRequest(req)) {
      sendJson(res, 403, {error: 'Cross-site requests are not allowed.'});
      return;
    }
    const login = auth.getGitHubUser(req);
    if (!login) {
      sendJson(res, 401, {error: 'GitHub authentication required.'});
      return;
    }

    const developer = db.getDeveloperByGitHub(login);
    const agent = developer ? db.getAgentById(developer.agentId) : undefined;
    if (!developer || !agent || agent.status === 'disabled') {
      sendJson(res, 403, {error: 'GitHub account is not registered to an Arena project.'});
      return;
    }

    const now = getNow();
    const eligibility = db.computeAgentSubmissionStatus(agent.id, now);
    const tournamentStatuses = db.computeAgentTournamentStatuses(agent.id, now);
    if (!eligibility.canSubmit && !tournamentStatuses.length) {
      const code = eligibility.label === 'Pending' || eligibility.label === 'Qualified'
        ? 403
        : 429;
      sendJson(res, code, {error: eligibility.reason ?? 'Not currently eligible to submit.'});
      return;
    }

    const retryAfter = checkSubmissionRateLimit(agent.id, now);
    if (retryAfter !== undefined) {
      sendJson(
        res,
        429,
        {error: `Too many submission attempts; wait ${retryAfter}s before retrying.`},
        {'Retry-After': String(retryAfter)}
      );
      return;
    }

    let payload: ReturnType<typeof parseSubmissionPayload>;
    try {
      const rawBody = await readBody(
        req,
        MAX_SUBMISSION_BYTES,
        'Submission payload exceeds 512 KB limit.'
      );
      payload = parseSubmissionPayload(rawBody, req.headers['content-type']);
    } catch (err: any) {
      sendJson(res, err?.status ?? 400, {error: err?.message || 'Malformed request body.'});
      return;
    }

    if (!VERSION_RE.test(payload.version)) {
      sendJson(res, 400, {
        error:
          'Invalid version string (must be 1–12 chars matching ^[A-Za-z0-9][A-Za-z0-9._-]{0,11}$).',
      });
      return;
    }

    const packageFormat: db.PackageFormat =
      payload.packageFormat === 'bundle' || payload.packageFormat === 'oci'
        ? payload.packageFormat
        : deducePackageFormat(payload.url);
    if (
      payload.packageFormat &&
      payload.packageFormat !== 'bundle' &&
      payload.packageFormat !== 'oci'
    ) {
      sendJson(res, 400, {error: 'Invalid package (expected "bundle" or "oci").'});
      return;
    }

    const urlErr = validateArtifactUrl(payload.url, packageFormat);
    if (urlErr) {
      sendJson(res, 400, {error: urlErr});
      return;
    }

    if (!SHA256_RE.test(payload.sha256)) {
      sendJson(res, 400, {error: 'Invalid SHA-256 (must be a 64-character hex digest).'});
      return;
    }
    const sha256 = payload.sha256.toLowerCase();

    if (!payload.ladders.length && !payload.tournaments.length) {
      sendJson(res, 400, {error: 'Select at least one active ladder or scheduled tournament.'});
      return;
    }
    if (payload.ladders.length > 0 && payload.tournaments.length > 0) {
      sendJson(res, 400, {
        error: 'Submit ladder versions and tournament entries separately (do not combine both).',
      });
      return;
    }
    if (
      payload.authToken &&
      // eslint-disable-next-line no-control-regex
      (payload.authToken.length > 4096 || /[\x00-\x1f\x7f]/.test(payload.authToken))
    ) {
      sendJson(res, 400, {error: 'Invalid authToken header.'});
      return;
    }
    if (db.getVersionBySlugAndLabel(agent.slug, payload.version)) {
      sendJson(res, 409, {
        error: `Version "${payload.version}" already exists for ${agent.name}.`,
      });
      return;
    }

    if (payload.ladders.length && !eligibility.canSubmit) {
      const code = eligibility.label === 'Pending' || eligibility.label === 'Qualified'
        ? 403
        : 429;
      sendJson(
        res,
        code,
        {error: eligibility.reason ?? 'Not currently eligible for ladder submissions.'}
      );
      return;
    }

    const tourneyStatusById = new Map(tournamentStatuses.map(t => [t.tournamentId, t]));
    const selectedTournamentIds: string[] = [];
    for (const rawTid of payload.tournaments) {
      const tStatus = tourneyStatusById.get(rawTid);
      if (!tStatus) {
        sendJson(res, 400, {error: `Unknown or closed tournament "${rawTid}".`});
        return;
      }
      if (!tStatus.canSubmit) {
        const code = now >= tStatus.closesAt ? 400 : 409;
        sendJson(res, code, {error: tStatus.reason ?? `Cannot submit to "${tStatus.name}".`});
        return;
      }
      if (!selectedTournamentIds.includes(tStatus.tournamentId)) {
        selectedTournamentIds.push(tStatus.tournamentId);
      }
    }

    if (selectedTournamentIds.length && packageFormat !== 'oci') {
      sendJson(res, 400, {
        error: 'Tournament submissions require an OCI image (package: "oci").',
      });
      return;
    }

    const currentLadders = db.getCurrentLadders();
    const byId = new Map(currentLadders.map(l => [l.id.toLowerCase(), l]));
    const bySlot = new Map(currentLadders.map(l => [l.slot.toLowerCase(), l]));
    const byName = new Map(currentLadders.map(l => [l.name.toLowerCase(), l]));

    const selectedLadders: db.LadderRow[] = [];
    const seenLadderIds = new Set<string>();
    for (const rawLadder of payload.ladders) {
      const key = rawLadder.toLowerCase();
      const ladder = byId.get(key) ?? bySlot.get(key) ?? byName.get(key);
      if (!ladder) {
        sendJson(res, 400, {error: `Unknown or closed ladder "${rawLadder}".`});
        return;
      }
      if (!seenLadderIds.has(ladder.id)) {
        seenLadderIds.add(ladder.id);
        selectedLadders.push(ladder);
      }
    }

    const poolsMap = getPools();
    const teamsByLadder: Record<string, string[]> = {};
    const hasSubmittedTeams = Array.isArray(payload.teams)
      ? payload.teams.some(t => t.trim().length > 0)
      : Boolean(payload.teams?.trim());

    const poolLadders = selectedLadders.filter(l => l.team === 'pools');
    if (!poolLadders.length && hasSubmittedTeams) {
      sendJson(res, 400, {
        error: 'Custom team pools are only accepted when entering a seasonal pools ladder.',
      });
      return;
    }

    for (const ladder of poolLadders) {
      const requiredTeams = ladder.teams!;
      const alreadyLocked = db.hasActiveLadderTeams(ladder.id, agent.id);
      if (alreadyLocked) {
        if (hasSubmittedTeams) {
          sendJson(res, 400, {
            error:
              `Your ${requiredTeams} teams for ${ladder.name} (${ladder.id}) ` +
              'are already locked for this season; omit teams to reuse your locked pool.',
          });
          return;
        }
        continue;
      }

      const existingSaved = db.getTeamsForAgentLadder(ladder.id, agent.id, 'saved');
      if (!hasSubmittedTeams || !payload.teams) {
        if (existingSaved.length === requiredTeams) {
          teamsByLadder[ladder.id] = existingSaved;
          continue;
        }
        const suffix = existingSaved.length > 0
          ? ` (${existingSaved.length}/${requiredTeams} distinct teams saved).`
          : '.';
        sendJson(res, 400, {
          error:
            `First submission to ${ladder.name} requires ${requiredTeams} ` +
            `valid teams passing the 1.30 uniqueness threshold${suffix}`,
          ladderId: ladder.id,
          savedCount: existingSaved.length,
          requiredCount: requiredTeams,
          remainingCount: requiredTeams - existingSaved.length,
          rejections: [] as RejectedTeam[],
        });
        return;
      }

      const pools = poolsMap.get(ladder.id) ?? [];
      const result = await validateCompetitorTeamsIncrementalForVersion(
        payload.teams,
        {
          format: ladder.format,
          pools,
          teams: requiredTeams,
        },
        existingSaved,
        ladder.version
      );

      if (result.allSaved.length !== existingSaved.length) {
        db.replaceSavedTeams(ladder.id, agent.id, result.allSaved, now);
      }

      if (!result.complete || result.rejections.length > 0) {
        const chunkCount = splitSubmittedTeams(payload.teams).length;
        const baseError = result.rejections.length > 0
          ? result.rejections[0].reason
          : `Expected ${requiredTeams} teams for ${ladder.format}, received ${chunkCount}.`;
        const progressNote = `(${result.allSaved.length}/${requiredTeams} distinct teams saved)`;
        sendJson(res, 400, {
          error: `${baseError} ${progressNote}`,
          ladderId: ladder.id,
          savedCount: result.allSaved.length,
          newlySavedCount: result.newlySavedCount,
          requiredCount: requiredTeams,
          remainingCount: result.remainingCount,
          rejections: result.rejections,
        });
        return;
      }

      teamsByLadder[ladder.id] = result.allSaved;
    }

    let authTokenEncoding: string | undefined;
    if (payload.authToken) {
      const secret = auth.getConfig()?.sessionSecret;
      if (!secret) {
        sendJson(res, 503, {error: 'SESSION_SECRET is required to encrypt authToken.'});
        return;
      }
      authTokenEncoding = encryptSecret(payload.authToken, secret);
    }

    try {
      const created = db.createSubmission({
        agentId: agent.id,
        developerId: developer.id,
        version: payload.version,
        package: packageFormat,
        url: payload.url,
        sha256,
        authTokenEncoding,
        ladderIds: selectedLadders.map(l => l.id),
        tournamentIds: selectedTournamentIds,
        teamsByLadder: Object.keys(teamsByLadder).length ? teamsByLadder : undefined,
        now,
      });

      if (req.headers.accept?.includes('application/json')) {
        sendJson(res, 201, {
          ok: true,
          versionId: created.id,
          version: created.version,
          smokeStatus: created.smokeStatus,
        });
        return;
      }
      redirect(res, '/account/', 303);
    } catch (err: any) {
      sendJson(res, err?.status ?? 500, {error: err?.message || 'Failed to save submission.'});
    }
  });
}
