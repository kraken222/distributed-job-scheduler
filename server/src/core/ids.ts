import { customAlphabet } from 'nanoid';

// URL-safe, no ambiguous characters; prefixed ids make log lines self-describing.
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const gen = customAlphabet(alphabet, 20);

export const newId = {
  org: () => `org_${gen()}`,
  user: () => `usr_${gen()}`,
  project: () => `prj_${gen()}`,
  queue: () => `que_${gen()}`,
  job: () => `job_${gen()}`,
  batch: () => `bat_${gen()}`,
  execution: () => `exe_${gen()}`,
  worker: () => `wrk_${gen()}`,
  schedule: () => `sch_${gen()}`,
  retryPolicy: () => `rp_${gen()}`,
  dlq: () => `dlq_${gen()}`,
  event: () => `evt_${gen()}`,
  trigger: () => `trg_${gen()}`,
};
