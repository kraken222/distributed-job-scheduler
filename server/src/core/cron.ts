import cronParser from 'cron-parser';

/** Throws with a readable message if the expression is invalid. */
export function assertValidCron(expression: string, timezone = 'UTC'): void {
  try {
    cronParser.parseExpression(expression, { tz: timezone });
  } catch (err) {
    throw new Error(`Invalid cron expression "${expression}": ${(err as Error).message}`);
  }
}

/** Next fire time (epoch ms) strictly after `after`. */
export function nextCronRun(expression: string, timezone = 'UTC', after: number = Date.now()): number {
  const it = cronParser.parseExpression(expression, {
    tz: timezone,
    currentDate: new Date(after),
  });
  return it.next().getTime();
}
