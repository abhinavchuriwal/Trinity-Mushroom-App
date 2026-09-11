const NepaliDate = require('nepali-date-converter').default;

// Nepal's official fiscal year runs Shrawan 1 (BS month 4) through the end of
// Ashadh (BS month 3) the following year, written like "2083/84".
function nepaliFiscalYear(adDateStr) {
  if (!adDateStr) return null;
  const jsDate = new Date(`${adDateStr}T12:00:00`);
  if (Number.isNaN(jsDate.getTime())) return null;
  const nd = new NepaliDate(jsDate);
  const bsYear = nd.getYear();
  const bsMonth = nd.getMonth() + 1; // library is 0-indexed
  const startYear = bsMonth >= 4 ? bsYear : bsYear - 1;
  const endYearShort = String(startYear + 1).slice(-2);
  return `${startYear}/${endYearShort}`;
}

module.exports = { nepaliFiscalYear };
