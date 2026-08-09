#!/usr/bin/env node
/**
 * Regression tests for the filter logic. Each case corresponds to a specific
 * failure in the original hand-written keyword strings. Run: npm test
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildMatchers, buildSources, classify, keysFor, termsToRegex } from './lib.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8'));

const roster = await readJson('data/roster.json');
const config = await readJson('data/config.json');
const m = buildMatchers(roster, config);

let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(`${label}\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const item = (title, mode = 'roster', summary = '') => ({
  title,
  summary,
  mode,
  link: `https://example.com/${encodeURIComponent(title.slice(0, 40))}`,
  guid: title,
  published: new Date().toUTCString(),
  source: 'test',
});

const kept = (title, mode, summary) => classify(item(title, mode, summary), m) !== null;
const players = (title, mode = 'roster') => classify(item(title, mode), m)?.players ?? null;
const isUrgent = (title) => classify(item(title), m)?.urgent ?? null;

// -- 1. Substring collateral damage from the original exclusion list ---------
// "line" / "spread" / "jersey" / "shop" as bare substrings destroyed these.
check('goal line news survives', kept('Bengals plan to use Chase Brown on goal-line carries'), true);
check('offensive line news survives', kept('Bo Nix protected by rebuilt offensive line'), true);
check('New Jersey survives', kept('Kenyon Sadiq turning heads in New Jersey camp'), true);
check('sideline survives', kept('AJ Brown seen on the sideline in a walking boot'), true);
check('spread offense survives', kept('Packers spread offense feeds Jordan Love'), true);

// -- 2. Gambling and merch spam still dropped -------------------------------
check('betting odds dropped', kept('Jordan Love receiving yards prop bet and betting odds'), false);
check('parlay dropped', kept('Best Chase Brown parlay for Sunday'), false);
check('promo dropped', kept('DraftKings promo code for Chargers game'), false);
check('ticket resale dropped', kept('Cheap Steelers tickets on StubHub, Kaleb Johnson returns'), false);

// -- 3. Name collisions isolated by per-player exclusions -------------------
check('Brad Pitt dropped', kept('Brad Pitt spotted at Falcons game with Kyle Pitts jersey'), false);
check('Pittsburgh news without Pitts not counted', players('Pittsburgh Steelers announce new stadium plans'), null);
check('Kyle Pitts counted', players('Kyle Pitts leads Falcons in receiving at camp'), ['Kyle Pitts']);
check('Britney Spears not counted', players('Britney Spears announces new tour dates'), null);
check('Tyjae Spears counted', players('Tyjae Spears takes first-team reps in Tennessee'), ['Tyjae Spears']);

// -- 4. Distinctive aliases match correctly --------------------------------
check('A.J. Brown alias matches', players('A.J. Brown dominates in Patriots practice'), ['AJ Brown']);
check('Pacheco alias matches', players('Pacheco breaks off 40-yard run in Lions camp'), ['Isiah Pacheco']);
check('Ollie Gordon II full name matches', players('Ollie Gordon II named starting RB for Dolphins'), ['Ollie Gordon II']);

// -- 5. No AND-gate on player names ----------------------------------------
check(
  'bare injury note passes with no buzzword',
  kept('Bo Nix questionable, ankle'),
  true
);
check('breaking role news passes', kept('Ashton Jeanty will start Week 1'), true);

// -- 6. Tier separation ----------------------------------------------------
check('team feed needs buzzword', kept('Tennessee Titans unveil new uniforms', 'team'), false);
check('team feed passes on buzzword', kept('Tennessee Titans release depth chart', 'team'), true);
check('roster feed never passes on buzzword alone', kept('Broncos release depth chart', 'roster'), false);

// -- 7. Urgency routing ----------------------------------------------------
check('inactive is urgent', isUrgent('Isiah Pacheco inactive for Sunday'), true);
check('ruled out is urgent', isUrgent('Emeka Egbuka ruled out with hamstring strain'), true);
check('target share is not urgent', isUrgent('Jordan Love leads league in target share'), false);
check('trade is urgent', isUrgent('Cade Otton traded to the Jets'), true);

// -- 8. Dedupe -------------------------------------------------------------
const a = item('Report: Ashton Jeanty to miss two weeks with a hamstring strain');
const b = {
  ...item('Report: Ashton Jeanty to miss two weeks with a hamstring strain -- via ESPN'),
  guid: 'different-guid-entirely',
  link: 'https://other.example.com/jeanty',
};
check('cross-source near-duplicate collides', keysFor(a).fuzzy === keysFor(b).fuzzy, true);
check('unrelated headline does not collide', keysFor(a).fuzzy === keysFor(item('Bills win')).fuzzy, false);

// -- 9. Regex construction safety -----------------------------------------
check('special chars escaped', termsToRegex(['over/under', 'C.J. Stroud']).test('over/under 44.5'), true);
check('empty list yields null', termsToRegex([]), null);

// -- 10. Source generation ------------------------------------------------
const sources = buildSources(roster, config);
const teamFeeds = sources.filter((s) => s.mode === 'team');
const rosterTeams = new Set(roster.players.map((p) => p.team));
check('one team feed per rostered team', teamFeeds.length, rosterTeams.size);
check('every player appears in a generated query',
  roster.players.every((p) => sources.some((s) => s.url.includes(encodeURIComponent(`"${p.name}"`)))),
  true
);
check('all URLs are https', sources.every((s) => s.url.startsWith('https://')), true);

// -- report ---------------------------------------------------------------
console.log(`\n  ${pass} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f}`);
  process.exit(1);
}
console.log('  Filter logic verified. Feed reachability is separate -- check status.json after the first run.\n');
