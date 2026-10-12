const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const dates = require('../dates.js');
process.env.TZ = 'Europe/London';

test('Month includes 30 local calendar days and all of today, without clock-time cutoffs', () => {
  const range = dates.progressRange('month', '', '', new Date(2026, 9, 12, 18, 30));
  assert.equal(dates.localDayKey(range.startDate), '2026-09-13');
  assert.equal(dates.localDayKey(range.endDate), '2026-10-13');
  assert.equal(dates.inProgressRange(new Date(2026, 8, 12, 23, 59, 59, 999), range), false);
  assert.equal(dates.inProgressRange(new Date(2026, 8, 13, 0, 0), range), true);
  assert.equal(dates.inProgressRange(new Date(2026, 9, 12, 23, 59, 59, 999), range), true);
  assert.equal(dates.inProgressRange(new Date(2026, 9, 13), range), false);
});
test('Year handles leap-day and year-end boundaries without losing a day', () => {
  const leap = dates.progressRange('year', '', '', new Date(2024, 1, 29));
  assert.equal(dates.localDayKey(leap.startDate), '2023-03-01');
  assert.equal(dates.localDayKey(leap.endDate), '2024-03-01');
  assert.equal(dates.inProgressRange('2024-02-29', leap), true);
  const year = dates.progressRange('year', '', '', new Date(2026, 11, 31));
  assert.equal(dates.localDayKey(year.startDate), '2026-01-01');
  assert.equal(dates.localDayKey(year.endDate), '2027-01-01');
});
test('Custom includes the complete final local day across both daylight-saving changes', () => {
  for (const [day, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const range = dates.progressRange('custom', day, day);
    assert.equal(range.error, null);
    assert.equal((range.endDate - range.startDate) / 3600000, hours);
    assert.equal(dates.inProgressRange(new Date(range.startDate.getTime() - 1), range), false);
    assert.equal(dates.inProgressRange(range.startDate, range), true);
    assert.equal(dates.inProgressRange(new Date(range.endDate.getTime() - 1), range), true);
    assert.equal(dates.inProgressRange(range.endDate, range), false);
  }
});
test('invalid, incomplete or reversed custom dates cannot silently fall back to all history', () => {
  for (const [from, to] of [['', '2026-10-12'], ['2026-10-12', ''], ['2026-02-30', '2026-03-01'], ['2026-10-13', '2026-10-12']]) {
    const range = dates.progressRange('custom', from, to);
    assert.ok(range.error);
    assert.equal(dates.inProgressRange('2026-10-12', range), false);
  }
  assert.equal(dates.inProgressRange('bad-date', dates.progressRange('all')), false);
  assert.equal(dates.inProgressRange('2020-01-01', dates.progressRange('all')), true);
});
test('custom date-only values stay local west of UTC', () => {
  const script = `const d=require(${JSON.stringify(require.resolve('../dates.js'))});const r=d.progressRange('custom','2026-09-30','2026-09-30');console.log(JSON.stringify([d.inProgressRange('2026-10-01T06:59:59Z',r),d.inProgressRange('2026-10-01T07:00:00Z',r),d.inProgressRange('2026-09-30',r)]));`;
  const values = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' }));
  assert.deepEqual(values, [true, false, true]);
});
