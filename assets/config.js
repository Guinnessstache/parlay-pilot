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
  helpline: { text: '1-800-GAMBLER', href: 'tel:18004262537' }
};
