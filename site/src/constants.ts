// src/constants.ts

// -----------------------------
// Robust API base resolution
// -----------------------------
// Priority order:
// 1) Frontend build env (Vite):         import.meta.env.VITE_API_BASE or VITE_APP_API_BASE
// 2) Frontend build env (Next/CRA):     process.env.NEXT_PUBLIC_API_BASE or REACT_APP_API_BASE_URL or REACT_APP_API_BASE
// 3) Runtime global (optional):         window.__API_BASE__
// 4) Fallback:                          http://localhost:3015  (dev default)

const __envBase: string =
  // Vite
  ((typeof import.meta !== 'undefined' && (import.meta as any).env &&
    (((import.meta as any).env.VITE_API_BASE) || ((import.meta as any).env.VITE_APP_API_BASE))) as string) ||
  // Next / CRA (during build)
  ((typeof process !== 'undefined' &&
    (process.env?.NEXT_PUBLIC_API_BASE ||
     process.env?.REACT_APP_API_BASE_URL ||
     process.env?.REACT_APP_API_BASE)) as string) ||
  // Optional: runtime global for extreme cases
  ((typeof window !== 'undefined' && (window as any).__API_BASE__) as string) ||
  '';

// Local dev default
const __localDefault = 'http://localhost:3015';

export const API_BASE: string = __envBase || __localDefault;

// Alias some projects expect
export const API_BASE_URL: string = API_BASE;

// Helper to join base + path safely (no double slashes)
const withBase = (p: string) =>
  `${String(API_BASE).replace(/\/$/, '')}/${String(p || '').replace(/^\//, '')}`;

// -----------------------------
// Common US states list
// -----------------------------
export const STATES = [
  { code: 'PA', name: 'Pennsylvania' },
  { code: 'CA', name: 'California' },
  { code: 'TX', name: 'Texas' },
  { code: 'FL', name: 'Florida' },
  { code: 'NY', name: 'New York' },
  { code: 'IL', name: 'Illinois' },
  { code: 'OH', name: 'Ohio' },
  { code: 'GA', name: 'Georgia' },
  { code: 'WA', name: 'Washington' },
  { code: 'MI', name: 'Michigan' },
  { code: 'NC', name: 'North Carolina' },
  { code: 'NJ', name: 'New Jersey' },
  { code: 'VA', name: 'Virginia' },
  { code: 'AZ', name: 'Arizona' },
  { code: 'MA', name: 'Massachusetts' },
  { code: 'MN', name: 'Minnesota' },
  { code: 'CO', name: 'Colorado' },
  { code: 'TN', name: 'Tennessee' },
  { code: 'IN', name: 'Indiana' },
  { code: 'MO', name: 'Missouri' },
  { code: 'MD', name: 'Maryland' },
  { code: 'WI', name: 'Wisconsin' },
  { code: 'SC', name: 'South Carolina' },
  { code: 'AL', name: 'Alabama' },
  { code: 'LA', name: 'Louisiana' },
  { code: 'KY', name: 'Kentucky' },
  { code: 'MS', name: 'Mississippi' },
  { code: 'AR', name: 'Arkansas' },
  { code: 'OR', name: 'Oregon' },
  { code: 'OK', name: 'Oklahoma' },
  { code: 'CT', name: 'Connecticut' },
  { code: 'IA', name: 'Iowa' },
  { code: 'KS', name: 'Kansas' },
  { code: 'UT', name: 'Utah' },
  { code: 'NV', name: 'Nevada' },
  { code: 'NM', name: 'New Mexico' },
  { code: 'NE', name: 'Nebraska' },
  { code: 'WV', name: 'West Virginia' },
  { code: 'ID', name: 'Idaho' },
  { code: 'HI', name: 'Hawaii' },
  { code: 'ME', name: 'Maine' },
  { code: 'NH', name: 'New Hampshire' },
  { code: 'RI', name: 'Rhode Island' },
  { code: 'DE', name: 'Delaware' },
];

// Month names used by SummaryDashboard
export const monthNames = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December'
];

// -----------------------------
// Centralized routes object
// -----------------------------
export const routes = {
  auth: {
    login:  withBase('/api/auth/login'),
    verify: withBase('/api/auth/verify'),
  },
  automation: {
    run: withBase('/api/automation/run'),
    service: {
      status:  withBase('/api/automation/service/status'),
      start:   withBase('/api/automation/service/start'),
      stop:    withBase('/api/automation/service/stop'),
      restart: withBase('/api/automation/service/restart'),
    },
    otp:       withBase('/api/automation/otp'),
    otpCancel: withBase('/api/automation/otp/cancel'),
    otpState:  withBase('/api/automation/otp'),
  },
  properties: {
    base:  withBase('/api/properties'),
    raw:   withBase('/api/properties/raw'),
    deals: withBase('/api/properties/deals'),
    table: withBase('/api/properties/table'),
  },
  propertiesTable: withBase('/api/properties/table'),
  users: {
    base:   withBase('/api/user'),
    create: withBase('/api/user/create'),
    update: (id: string) => withBase(`/api/user/update/${id}`),
    delete: (id: string) => withBase(`/api/user/delete/${id}`),
  },
};

// -----------------------------
// Backward-compatible named exports
// -----------------------------
export const automationRoute    = routes.automation.run;
export const propertiesRoute    = routes.properties.base;
export const rawPropertiesRoute = routes.properties.raw;
export const loginRoute         = routes.auth.login;
export const verifyRoute        = routes.auth.verify;
export const userRoute          = routes.users.base;
export const otpRoute           = routes.automation.otp;
export const otpCancelRoute     = routes.automation.otpCancel;
export const otpStateRoute      = routes.automation.otpState;
export const createUserRoute    = routes.users.create;
export const updateUserRoute    = routes.users.update;
export const deleteUserRoute    = routes.users.delete;