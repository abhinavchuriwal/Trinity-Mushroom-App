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

module.exports = { daysBetween };
