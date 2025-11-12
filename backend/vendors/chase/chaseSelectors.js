// vendors/chase/chaseSelectors.js
export const CHASE_URL = process.env.CHASE_URL
  || 'https://www.chase.com/personal/mortgage/calculators-resources/home-value-estimator';

export const SEL = {
  addressInput: '#txtStreetAddress',
  searchBtn: '#btnGO',
  suggestMenu: '#ui-id-1',
  suggestItems: '#ui-id-1 a.ui-menu-item-wrapper',
  estimateLabel: '#lblValue',
  addressErrorTitle: '#dialogTitle_label', // "Address Search Error"
};

export const TIMING = {
  navTimeoutMs: Number(process.env.PRIVY_NAV_TIMEOUT_MS || 120000),
  selectorTimeoutMs: 30000,
  suggestionWaitMs: Number(process.env.BOFA_SUGGESTION_WAIT_MS || 800),
  keyRetryMs: Number(process.env.BOFA_ENTER_RETRY_MS || 600),
  networkIdleMs: 1500,
};

export const RUN_LIMIT = {
  limit: Number(process.env.LIMIT || 1000),
  startSkip: Number(process.env.START_SKIP || 0),
  maxAttemptsPerAddress: 2,
};