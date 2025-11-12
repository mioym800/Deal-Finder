// =========================
// OTP helpers
// =========================
import { API_BASE, routes } from "./constants.ts";

// Debug: log API base once in dev
if (typeof window !== 'undefined' && !window.__API_BASE_LOGGED__) {
  console.log('[helpers] API_BASE =', API_BASE);
  window.__API_BASE_LOGGED__ = true;
}

/**
 * Submit the OTP code to the automation OTP endpoint.
 * Accepts either a plain string code or an object { id, code, service }.
 * When `id` is provided it will be forwarded so the backend can match the
 * specific pending OTP request.
 * @param {string|{id?:string, code:string, service?:string}} input
 * @returns {Promise<object>} Response JSON.
 */
export async function submitOtpCode(input) {
  // Backward compatible: allow submitOtpCode('123456')
  // New shape: submitOtpCode({ id, code, service })
  let payload;
  if (typeof input === 'string') {
    payload = { code: input };
  } else if (input && typeof input === 'object') {
    const { id, code, service } = input;
    payload = { code: String(code || '').trim() };
    if (id) payload.id = String(id);
    if (service) payload.service = String(service);
  } else {
    payload = { code: String(input || '').trim() };
  }

  const res = await apiFetch(routes.automation.otp, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.json();
}

/**
 * Cancel the current OTP request.
 * @returns {Promise<object>} Response JSON.
 */
export async function cancelOtpRequest() {
  const res = await apiFetch(routes.automation.otpCancel, {
    method: "POST",
  });
  return res.json();
}

/**
 * Get current OTP request state from the backend.
 * @returns {Promise<object>} Response JSON like
 *   { ok, otp: { id, service, awaiting, timeoutMs, requestedAt } | null }
 */
export async function getOtpState() {
  const res = await apiFetch(routes.automation.otpState);
  return res.json();
}
// site/src/helpers.js
// Centralized API calls + token handling.
// Relies on API_BASE and routes from constants.ts

// ---- Token helpers ----
const TOKEN_KEY = "authToken";
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

// ---- Low-level fetch wrapper (adds Bearer token if present) ----
export const apiFetch = (url, opts = {}) => {
  // Build absolute URL: if `url` is relative, prefix with API_BASE
  const fullUrl = /^https?:\/\//i.test(url)
    ? url
    : `${API_BASE.replace(/\/$/, '')}/${String(url).replace(/^\//, '')}`;

  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(fullUrl, { ...opts, headers });
};

// =========================
// Auth
// =========================

/**
 * Login helper
 * - POSTs email/password
 * - on success stores token in localStorage
 * - returns { success, user, token } or { success:false, error }
 */
export async function fetchLogin(email, password) {
  try {
    const res = await apiFetch(routes.auth.login, {
      method: 'POST',
      body: JSON.stringify({
        email: String(email || '').toLowerCase(),
        password,
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.success && data?.token) {
      setToken(data.token);
      return { success: true, user: data.user || null, token: data.token };
    }
    const error = data?.error || `Login failed (HTTP ${res.status})`;
    return { success: false, error };
  } catch (e) {
    return { success: false, error: e?.message || 'Login failed' };
  }
}

/** Verify current token -> { success, user } */
export async function verify() {
  try {
    const res = await apiFetch(routes.auth.verify);
    const data = await res.json().catch(() => ({}));
    return data;
  } catch (e) {
    return { success: false, error: e?.message || "verify_failed" };
  }
}

// =========================
/* Properties / Dashboard */
// =========================

/** New dashboard table (server computes LP80, AMV40, AMV30) */
export async function getDashboardRows() {
  const res = await apiFetch(routes.propertiesTable);
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Failed to load properties table (HTTP ${res.status}) :: ${text.slice(0, 200)}`);
  }
  if (!ctype.includes('application/json')) {
    const text = await res.text().catch(() => '');
    throw new Error(`Non-JSON from ${res.url} (content-type: ${ctype}). Preview: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/** Raw property list (optional usage for summary) */
export async function fetchRawProperties(setter) {
  try {
    const res = await apiFetch(routes.rawProperties);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setter(data);
  } catch (e) {
    console.error("Error fetching raw properties:", e);
    setter([]);
  }
}

/** Full properties (optional if you only need /table) */
export async function fetchProperties(setter) {
  try {
    const res = await apiFetch(routes.properties);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setter(data);
  } catch (e) {
    console.error("Error fetching properties:", e);
    setter([]);
  }
}

// Update a property by id (accepts the same shape your table uses)
export async function updatePropertyById(id, payload) {
  const res = await apiFetch(`/api/properties/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data; // { ok, id, prop_id }
}

// Delete a property by id/prop_id/fullAddress
export async function deletePropertyById(id) {
  const res = await apiFetch(`/api/properties/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (res.status === 204) return { ok: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

// =========================
// Automation controls (optional)
// =========================
export async function runAutomation(payload = {}) {
  try {
    const res = await apiFetch(routes.automationRun, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (e) {
    console.error("Error running automation:", e);
    return { ok: false, error: e?.message || "automation_error" };
  }
}

export async function getServiceStatus() {
  const res = await apiFetch(routes.service.status);
  return res.json();
}
export async function startService() {
  const res = await apiFetch(routes.service.start, { method: "POST" });
  return res.json();
}
export async function stopService() {
  const res = await apiFetch(routes.service.stop, { method: "POST" });
  return res.json();
}
export async function restartService() {
  const res = await apiFetch(routes.service.restart, { method: "POST" });
  return res.json();
}

// =========================
// User management (admin)
// =========================

// ---- Users (Admin) ----

export async function getUsers() {
  try {
    const res = await apiFetch(routes.users.base);
    const text = await res.text();
    let data = [];
    try { data = JSON.parse(text); } catch { /* keep raw */ }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0,120)}`);
    const arr = Array.isArray(data) ? data : (data?.users || []);
    return { ok: true, data: arr };
  } catch (e) {
    console.error('getUsers error:', e);
    return { ok: false, error: e?.message || 'fetch_users_failed' };
  }
}

export async function createUser(payload) {
  try {
    const res = await apiFetch(routes.users.create, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (e) {
    console.error('createUser error:', e);
    return { ok: false, error: e?.message || 'create_failed' };
  }
}

export async function updateUser(id, payload) {
  try {
    const res = await apiFetch(routes.users.update(id), {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (e) {
    console.error('updateUser error:', e);
    return { ok: false, error: e?.message || 'update_failed' };
  }
}

export async function deleteUser(id) {
  try {
    const res = await apiFetch(routes.users.delete(id), { method: 'DELETE' });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return { ok: true, data };
  } catch (e) {
    console.error('deleteUser error:', e);
    return { ok: false, error: e?.message || 'delete_failed' };
  }
}

// Convenience export bundle (optional)
export default {
  apiFetch,
  getToken,
  setToken,
  clearToken,
  fetchLogin,
  verify,
  getDashboardRows,
  fetchProperties,
  fetchRawProperties,
  runAutomation,
  getServiceStatus,
  startService,
  stopService,
  restartService,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  submitOtpCode,
  cancelOtpRequest,
  getOtpState,
};