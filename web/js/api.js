// api.js — thin client for the local Lazy - Cut server (SPEC §4).
//
// - The auth token arrives once as `?t=<token>` in the window URL; it is kept in sessionStorage
//   (survives reloads of this window) and stripped from the address bar.
// - api.get / api.post resolve to the parsed `{ok:true,...}` body and throw Error(<Korean message>)
//   with `.code` (server slug, or 'network' / 'http_<status>') and `.status` otherwise.
// - A heartbeat hits /api/health every 20 s (keeps the server's idle watchdog happy) and dispatches
//   window events 'lazycut:offline' / 'lazycut:online' when connectivity changes.
// Assumptions: api.init() is called by main.js at boot; any call made earlier initializes lazily.
// api.post accepts an optional third argument {keepalive, signal} (used for the unload flush).

import { toast } from './util.js';

const TOKEN_KEY = 'lazycut.token';
const HEARTBEAT_MS = 20000;

let token = null;
let inited = false;
let heartbeatTimer = null;
let online = true;
let healthFails = 0;
let authWarned = false;

function hasWindow() {
  return typeof window !== 'undefined' && typeof location !== 'undefined';
}

function readToken() {
  let t = null;
  try {
    const url = new URL(location.href);
    t = url.searchParams.get('t');
    if (t) {
      try { sessionStorage.setItem(TOKEN_KEY, t); } catch (_) { /* private mode etc. */ }
      url.searchParams.delete('t');
      const clean = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
      try { history.replaceState(history.state, '', clean); } catch (_) { /* ignore */ }
      return t;
    }
  } catch (_) { /* ignore */ }
  try { t = sessionStorage.getItem(TOKEN_KEY); } catch (_) { t = null; }
  return t;
}

function ensureInit() {
  if (!inited) init();
}

/** Read the token and start the heartbeat. Safe to call more than once. */
export function init() {
  if (inited) return api;
  inited = true;
  if (!hasWindow()) return api;
  token = readToken();
  startHeartbeat();
  return api;
}

function setOnline(value) {
  if (online === value) return;
  online = value;
  try { window.dispatchEvent(new CustomEvent(value ? 'lazycut:online' : 'lazycut:offline')); } catch (_) { /* ignore */ }
  if (value) toast('Lazy - Cut과 다시 연결됐어요.', 'ok');
  else toast('Lazy - Cut과 연결이 끊겼어요. 앱이 켜져 있는지 확인해 주세요.', 'error', 8000);
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(async () => {
    try {
      await request('GET', '/api/health', undefined, { quiet: true });
      healthFails = 0;
      setOnline(true);
    } catch (err) {
      if (err && err.status === 401) return; // handled by the auth warning
      healthFails += 1;
      if (healthFails >= 2) setOnline(false);
    }
  }, HEARTBEAT_MS);
}

function statusMessage(status) {
  if (status === 401) return '연결 정보가 만료됐어요. Lazy - Cut을 다시 열어 주세요.';
  if (status === 403) return '이 창에서는 Lazy - Cut에 접근할 수 없어요.';
  if (status === 404) return '요청한 항목을 찾을 수 없어요.';
  if (status === 409) return '이미 같은 파일이 있어요.';
  if (status === 413) return '보낼 데이터가 너무 커요.';
  if (status >= 500) return 'Lazy - Cut 안에서 문제가 생겼어요. 잠시 후 다시 해 주세요.';
  return `요청을 처리하지 못했어요 (${status}).`;
}

function warnAuth() {
  if (authWarned) return;
  authWarned = true;
  toast(statusMessage(401), 'error', 10000);
}

function networkError(cause) {
  const err = new Error('Lazy - Cut 서버에 연결할 수 없어요. 앱이 켜져 있는지 확인해 주세요.');
  err.code = 'network';
  err.status = 0;
  err.cause = cause;
  return err;
}

async function request(method, path, body, opts = {}) {
  ensureInit();
  const headers = { 'X-LazyCut-Token': token || '' };
  const req = { method, headers, cache: 'no-store' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    req.body = JSON.stringify(body);
  }
  if (opts.keepalive) req.keepalive = true;
  if (opts.signal) req.signal = opts.signal;
  let res;
  try {
    res = await fetch(path, req);
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw networkError(e);
  }
  let data = null;
  const ct = (res.headers.get('Content-Type') || '').toLowerCase();
  if (ct.includes('json')) {
    try { data = await res.json(); } catch (_) { data = null; }
  }
  if (!res.ok || !data || data.ok === false) {
    const msg = (data && data.error) || (res.ok ? '서버 응답을 읽지 못했어요.' : statusMessage(res.status));
    const err = new Error(msg);
    err.code = (data && data.code) || (res.ok ? 'bad_response' : `http_${res.status}`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && !opts.quiet) warnAuth();
    throw err;
  }
  if (!online && !opts.quiet) { healthFails = 0; setOnline(true); }
  return data;
}

/** GET a JSON API path. */
export function get(path, opts) {
  return request('GET', path, undefined, opts);
}

/** POST a JSON body to an API path. */
export function post(path, body = {}, opts) {
  return request('POST', path, body, opts);
}

/** URL for the <video> element (token in the query, as the server allows for /media/*). */
export function mediaUrl(projectId, { proxy = false } = {}) {
  ensureInit();
  const q = new URLSearchParams({ t: token || '', proxy: proxy ? '1' : '0' });
  return `/media/${encodeURIComponent(projectId)}/video?${q.toString()}`;
}

/** Waveform peaks: uint8, 100 values per second. Throws with code 'not_ready' until prep is done. */
export async function peaks(projectId) {
  ensureInit();
  let res;
  try {
    res = await fetch(`/api/project/${encodeURIComponent(projectId)}/peaks`, {
      headers: { 'X-LazyCut-Token': token || '' },
      cache: 'no-store',
    });
  } catch (e) {
    throw networkError(e);
  }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    const err = new Error((data && data.error) || statusMessage(res.status));
    err.code = (data && data.code) || `http_${res.status}`;
    err.status = res.status;
    throw err;
  }
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Poll a background job until it finishes.
 * onUpdate(job) runs after every poll. Resolves with the job on 'done'; rejects on 'error'/'canceled'
 * with an Error carrying `.job` and `.code` ('error' | 'canceled'). Transient network errors are retried.
 */
export function pollJob(jobId, onUpdate, intervalMs = 400) {
  return new Promise((resolve, reject) => {
    let fails = 0;
    const schedule = (ms) => setTimeout(tick, ms);
    const tick = async () => {
      let job;
      try {
        const r = await get(`/api/jobs/${encodeURIComponent(jobId)}`, { quiet: true });
        job = r.job;
        fails = 0;
      } catch (err) {
        if (err && err.code === 'network' && fails < 20) {
          fails += 1;
          schedule(Math.min(4000, intervalMs * Math.pow(1.6, fails)));
          return;
        }
        reject(err);
        return;
      }
      if (!job) {
        const err = new Error('작업 정보를 찾을 수 없어요.');
        err.code = 'missing_job';
        reject(err);
        return;
      }
      if (typeof onUpdate === 'function') {
        try { onUpdate(job); } catch (e) {
          if (typeof console !== 'undefined') console.error('[api] pollJob onUpdate failed', e);
        }
      }
      if (job.state === 'done') resolve(job);
      else if (job.state === 'error' || job.state === 'canceled') {
        const msg = job.state === 'canceled' ? '작업을 취소했어요.' : (job.error || job.message || '작업 중 문제가 생겼어요.');
        const err = new Error(msg);
        err.code = job.state;
        err.job = job;
        reject(err);
      } else schedule(intervalMs);
    };
    tick();
  });
}

/** Current token (read-only; used by modules that build their own URLs). */
export function getToken() {
  ensureInit();
  return token;
}

export function isOnline() {
  return online;
}

export const api = { init, get, post, mediaUrl, peaks, pollJob, getToken, isOnline };
export default api;
