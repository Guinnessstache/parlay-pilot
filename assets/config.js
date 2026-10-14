// Site settings. Edit and push - no build step.
export const CONFIG = {
  siteName: 'Parlay Pilot',
  // Sportsbook web hosts used to build bet-slip links. Some states use their own
  // subdomain - if links land on the wrong state site, change these.
  fanduelHost: 'https://sportsbook.fanduel.com',
  draftkingsHost: 'https://sportsbook.draftkings.com',
  defaultBook: 'draftkings',
  defaultStake: 10,
  defaultWin: 100,
  maxLegsCap: 10,
  // Warn when the odds snapshot is older than this many minutes.
  staleAfterMinutes: 180,
  // Must match the cron in .github/workflows/update-data.yml (UTC hours, days 0=Sun).
  refreshSchedule: [{ hoursUTC: [14, 19, 23], minute: 7, days: [0, 1, 4] }, { hoursUTC: [13], minute: 7, days: [2, 3, 5, 6] }],
  // Owner-only Sync button: visit the site once with ?owner=1 (?owner=0 hides it again).
  repo: 'Guinnessstache/parlay-pilot',
  workflowFile: 'update-data.yml',
  helpline: { text: '1-800-GAMBLER', href: 'tel:18004262537' }
};
