// src/constants.ts

// Resolve API base (frontend .env takes priority, then CRA dev proxy fallback)
export const API_BASE: string =
  (process.env.REACT_APP_API_BASE_URL as string) ||
  'http://localhost:3015';

// Alias some projects expect
export const API_BASE_URL = API_BASE;

// Common US states list
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

// Centralized routes object (preferred)
export const routes = {
  auth: {
    login: `${API_BASE}/api/auth/login`,
    verify: `${API_BASE}/api/auth/verify`,
  },
  automation: {
    run: `${API_BASE}/api/automation/run`,
    service: {
      status: `${API_BASE}/api/automation/service/status`,
      start:  `${API_BASE}/api/automation/service/start`,
      stop:   `${API_BASE}/api/automation/service/stop`,
      restart:`${API_BASE}/api/automation/service/restart`,
    },
    otp: `${API_BASE}/api/automation/otp`,
    otpCancel: `${API_BASE}/api/automation/otp/cancel`,
    otpState: `${API_BASE}/api/automation/otp`,
  },
  properties: {
    base: `${API_BASE}/api/properties`,
    raw:  `${API_BASE}/api/properties/raw`,
    deals:`${API_BASE}/api/properties/deals`,
    table:`${API_BASE}/api/properties/table`,
  },
  propertiesTable: `${API_BASE}/api/properties/table`,
  users: {
    base:   `${API_BASE}/api/user`,
    create: `${API_BASE}/api/user/create`,
    update: (id: string) => `${API_BASE}/api/user/update/${id}`,
    delete: (id: string) => `${API_BASE}/api/user/delete/${id}`,
  },
};

// Backward-compatible named exports (so existing imports keep working)
export const automationRoute   = routes.automation.run;
export const propertiesRoute   = routes.properties.base;
export const rawPropertiesRoute= routes.properties.raw;
export const loginRoute        = routes.auth.login;
export const verifyRoute       = routes.auth.verify;
export const userRoute         = routes.users.base;
export const otpRoute          = routes.automation.otp;
export const otpCancelRoute    = routes.automation.otpCancel;
export const otpStateRoute     = routes.automation.otpState;
export const createUserRoute   = routes.users.create;
export const updateUserRoute   = routes.users.update;
export const deleteUserRoute   = routes.users.delete;