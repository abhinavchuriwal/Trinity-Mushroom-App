// Whole days between two YYYY-MM-DD date strings (inclusive of the start day
// is NOT applied here — this is a plain calendar-day difference). Returns null
// unless both dates are present and valid.
function daysBetween(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

// Today's date (YYYY-MM-DD) on the farm's clock, not the server's. The cloud
// host runs on UTC, which is 5h45m behind Nepal — without this, a turn reading
// logged at 5am Nepal time would be stamped with yesterday's date.
const FARM_TZ = process.env.TRINITY_TZ || 'Asia/Kathmandu';

function todayLocal() {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: FARM_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

module.exports = { daysBetween, todayLocal, FARM_TZ };
