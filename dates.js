/* Local calendar dates and chart periods. Workout timestamps remain unchanged. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LiftLogDates = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];

  function parseLocalDay(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(NaN);
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date : new Date(NaN);
  }

  function asDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? parseLocalDay(value) : new Date(value);
  }

  function localDayKey(value = new Date()) {
    const date = asDate(value);
    if (!Number.isFinite(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  // Calendar-day arithmetic avoids 23/25-hour days during daylight-saving changes.
  function dayNumber(value) {
    const date = asDate(value);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;
  }

  function periodInfo(period, granularity = "daily", offset = 0, now = new Date()) {
    let startDate, endDate, labels, labelText;
    if (period === "week") {
      startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + offset * 7);
      endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
      labels = DAYS.slice();
      const lastDay = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate() - 1);
      const format = { day: "numeric", month: "short" };
      labelText = offset === 0 ? "This Week"
        : `${startDate.toLocaleDateString("en-GB", format)} - ${lastDay.toLocaleDateString("en-GB", format)}`;
    } else if (period === "month") {
      startDate = new Date(now.getFullYear(), now.getMonth() + offset, 1);
      endDate = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 1);
      const days = dayNumber(endDate) - dayNumber(startDate);
      labels = Array.from({ length: granularity === "weekly" ? Math.ceil(days / 7) : days },
        (_, i) => granularity === "weekly" ? `Wk ${i + 1}` : String(i + 1));
      labelText = `${MONTHS[startDate.getMonth()]} ${startDate.getFullYear()}`;
    } else {
      startDate = new Date(now.getFullYear() + offset, 0, 1);
      endDate = new Date(startDate.getFullYear() + 1, 0, 1);
      const days = dayNumber(endDate) - dayNumber(startDate);
      labels = granularity === "weekly"
        ? Array.from({ length: Math.ceil(days / 7) }, (_, i) => String(i + 1))
        : MONTHS.map(month => month.slice(0, 3));
      labelText = String(startDate.getFullYear());
    }
    // endDate is exclusive, so every time on the final calendar day is included.
    return { startDate, endDate, labels, labelText, period, granularity };
  }

  function inPeriod(value, startDate, endDate) {
    const date = asDate(value);
    return date >= startDate && date < endDate;
  }

  function progressRange(period = 'all', from = '', to = '', now = new Date()) {
    const today = asDate(now);
    const endDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (period === 'month') return { startDate: new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29), endDate, label: 'Last 30 days', error: null };
    if (period === 'year') return { startDate: new Date(endDate.getFullYear() - 1, endDate.getMonth(), endDate.getDate()), endDate, label: 'Last 12 months', error: null };
    if (period !== 'custom') return { startDate: null, endDate: null, label: 'All time', error: null };
    const startDate = parseLocalDay(from), lastDate = parseLocalDay(to);
    if (!Number.isFinite(startDate.getTime()) || !Number.isFinite(lastDate.getTime())) return { startDate: null, endDate: null, label: 'Custom dates', error: 'Choose a valid From and To date.' };
    if (startDate > lastDate) return { startDate: null, endDate: null, label: 'Custom dates', error: 'From must be on or before To.' };
    const format = { day: 'numeric', month: 'short', year: 'numeric' };
    return { startDate, endDate: new Date(lastDate.getFullYear(), lastDate.getMonth(), lastDate.getDate() + 1),
      label: `${startDate.toLocaleDateString('en-GB', format)} – ${lastDate.toLocaleDateString('en-GB', format)}`, error: null };
  }

  function inProgressRange(value, range) {
    const date = asDate(value);
    return !range.error && Number.isFinite(date.getTime()) && (!range.startDate || date >= range.startDate) && (!range.endDate || date < range.endDate);
  }

  function breakdownIndex(value, startDate, period, maxLabels, granularity = "daily") {
    const date = asDate(value);
    const days = dayNumber(date) - dayNumber(startDate);
    let index;
    if (period === "week") index = days;
    else if (granularity === "weekly") index = Math.floor(days / 7);
    else if (period === "month") index = days;
    else index = (date.getFullYear() - startDate.getFullYear()) * 12 + date.getMonth() - startDate.getMonth();
    return Number.isInteger(index) && index >= 0 && index < maxLabels ? index : -1;
  }

  function nonnegative(value) {
    return value !== null && value !== undefined && String(value).trim() !== ""
      && Number.isFinite(Number(value)) && Number(value) >= 0;
  }

  function completedSets(sets, exercise) {
    if (!Array.isArray(sets)) return [];
    return sets.filter(set => {
      if (!set || set.completed === false) return false;
      if (exercise && exercise.type === "cardio") {
        return (nonnegative(set.time) && Number(set.time) > 0)
          || (nonnegative(set.dist) && Number(set.dist) > 0);
      }
      const hasWeight = set.w !== null && set.w !== undefined && String(set.w).trim() !== "";
      return nonnegative(set.r) && Number(set.r) > 0 && Number.isInteger(Number(set.r))
        && (!hasWeight || nonnegative(set.w));
    });
  }

  function completedExerciseIds(session, exercises = {}) {
    const entries = session.entries || {};
    const ids = [...new Set([...(session.order || []), ...Object.keys(entries)])];
    return ids.filter(id => completedSets(entries[id], exercises[id]).length > 0);
  }

  return { localDayKey, parseLocalDay, periodInfo, inPeriod, progressRange, inProgressRange, breakdownIndex, completedSets, completedExerciseIds };
});
