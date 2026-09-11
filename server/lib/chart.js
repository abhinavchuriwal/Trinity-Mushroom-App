function escapeXml(s) {
  return String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
}

// points: [{ x: string label, y: number|null }]
// band: { min, max } optional target range, drawn as a shaded reference band
function lineChart(points, { unit = '', band = null, height = 150 } = {}) {
  const valid = points.filter((p) => p.y !== null && p.y !== undefined);
  if (valid.length === 0) {
    return '<div class="muted">No readings yet.</div>';
  }
  const width = Math.max(320, points.length * 60);
  const padding = { top: 14, right: 16, bottom: 26, left: 40 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  const values = valid.map((p) => p.y);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (band) {
    if (band.min !== null && band.min !== undefined) min = Math.min(min, band.min);
    if (band.max !== null && band.max !== undefined) max = Math.max(max, band.max);
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.12;
  min -= pad;
  max += pad;

  const xFor = (i) => padding.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const yFor = (v) => padding.top + plotH - ((v - min) / (max - min)) * plotH;

  let svg = `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" class="linechart">`;

  // target band
  if (band && band.min !== null && band.min !== undefined && band.max !== null && band.max !== undefined) {
    const y1 = yFor(band.max);
    const y2 = yFor(band.min);
    svg += `<rect x="${padding.left}" y="${y1}" width="${plotW}" height="${y2 - y1}" fill="#2f6b45" opacity="0.08" />`;
  }

  // axis lines
  svg += `<line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${padding.top + plotH}" stroke="#d7dcdf" />`;
  svg += `<line x1="${padding.left}" y1="${padding.top + plotH}" x2="${padding.left + plotW}" y2="${padding.top + plotH}" stroke="#d7dcdf" />`;

  // y-axis min/max labels
  svg += `<text x="${padding.left - 6}" y="${padding.top + 4}" font-size="10" fill="#7a828a" text-anchor="end">${Math.round(max)}</text>`;
  svg += `<text x="${padding.left - 6}" y="${padding.top + plotH}" font-size="10" fill="#7a828a" text-anchor="end">${Math.round(min)}</text>`;

  // line + points
  const linePoints = points
    .map((p, i) => (p.y === null || p.y === undefined ? null : `${xFor(i)},${yFor(p.y)}`))
    .filter(Boolean)
    .join(' ');
  svg += `<polyline points="${linePoints}" fill="none" stroke="#2f6b45" stroke-width="2" />`;

  points.forEach((p, i) => {
    if (p.y === null || p.y === undefined) return;
    svg += `<circle cx="${xFor(i)}" cy="${yFor(p.y)}" r="3" fill="#1f3d2b" />`;
    svg += `<text x="${xFor(i)}" y="${yFor(p.y) - 8}" font-size="10" fill="#23272b" text-anchor="middle">${p.y}${escapeXml(unit)}</text>`;
    svg += `<text x="${xFor(i)}" y="${padding.top + plotH + 16}" font-size="9" fill="#7a828a" text-anchor="middle">${escapeXml(p.x)}</text>`;
  });

  svg += '</svg>';
  return svg;
}

module.exports = { lineChart };
