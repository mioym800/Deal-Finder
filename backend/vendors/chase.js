// jobs/chase.js
import dotenv from 'dotenv';
dotenv.config();

import runChaseJob from '../vendors/chase/chaseJob.js';

runChaseJob()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[CHASE_JOB_FATAL]', err?.stack || err);
    process.exit(1);
  });