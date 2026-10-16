// commands.js — tiny command registry shared by the toolbar, shortcuts, menus and panels (DOM-free).
//
// Usage: register('split', fn, {label: '클립 나누기', keys: 'Enter'}); run('split');
// Exported both as named functions and as a `commands` object (+ default) so either import style works.
// Assumptions: run() returns whatever the handler returns (a Promise for async handlers); thrown errors
// and rejected promises are routed to the error handler set with setErrorHandler() (main.js shows a toast).

const registry = new Map();
let errorHandler = null;
const listeners = new Set();

function warn(...args) {
  if (typeof console !== 'undefined' && console.warn) console.warn(...args);
}

/** Register (or replace) a command. */
export function register(name, fn, { label = '', keys = '' } = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('command name required');
  if (typeof fn !== 'function') throw new TypeError(`command "${name}" needs a function`);
  registry.set(name, { name, fn, label, keys });
  for (const l of listeners) {
    try { l(name); } catch (_) { /* ignore */ }
  }
}

/** Run a command by name. Unknown names are a no-op with a console warning. */
export function run(name, ...args) {
  const cmd = registry.get(name);
  if (!cmd) {
    warn(`[commands] unknown command: ${name}`);
    return undefined;
  }
  try {
    const out = cmd.fn(...args);
    if (out && typeof out.then === 'function') {
      return out.catch((err) => { report(err, name); return undefined; });
    }
    return out;
  } catch (err) {
    report(err, name);
    return undefined;
  }
}

export function has(name) {
  return registry.has(name);
}

/** [{name, label, keys}] in registration order. */
export function list() {
  return Array.from(registry.values(), ({ name, label, keys }) => ({ name, label, keys }));
}

/** fn(error, commandName) is called when a command throws or rejects. */
export function setErrorHandler(fn) {
  errorHandler = typeof fn === 'function' ? fn : null;
}

/** fn(name) is called whenever a command is (re)registered — lets the toolbar enable late-registered buttons. */
export function onRegister(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function report(err, name) {
  if (errorHandler) {
    try { errorHandler(err, name); return; } catch (_) { /* fall through */ }
  }
  warn(`[commands] "${name}" failed:`, err);
}

export const commands = { register, run, has, list, setErrorHandler, onRegister };
export default commands;
