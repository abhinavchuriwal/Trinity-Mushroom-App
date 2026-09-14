// Weighted-average C:N ratio: sum(dry_kg * C%) / sum(dry_kg * N%). Carbon%,
// Nitrogen% and Moisture% are all dry-basis/as-a-fraction-of-the-material
// figures, but qty_kg is the WET, as-weighed delivery weight — so each item's
// contribution has to be converted to dry matter (qty_kg * (1 - moisture/100))
// before it's weighted in. Skipping that (as this used to) overstates C and N
// whenever moisture varies between ingredients, which it always does in
// practice (fresh manure vs. air-dried straw). Uses each item's actual/tested
// value when present, falling back to the material's standard %.
function summarizeIntakeItems(items) {
  let totalWetKg = 0;
  let totalDryKg = 0;
  let totalCostNpr = 0;
  let hasCost = false;
  let carbonWeighted = 0;
  let nitrogenWeighted = 0;
  let ashWeighted = 0;
  let ashKnownDryKg = 0;
  items.forEach((it) => {
    const wetKg = it.qty_kg || 0;
    totalWetKg += wetKg;
    if (it.cost_per_kg_npr !== null && it.cost_per_kg_npr !== undefined) {
      hasCost = true;
      // Cost is paid per kg as-delivered (wet), not per kg of dry matter.
      totalCostNpr += wetKg * it.cost_per_kg_npr;
    }
    const moisture = it.moisture_pct_actual ?? it.moisture_pct_standard;
    // Unknown moisture falls back to treating the item as already-dry (0%
    // loss) rather than dropping it from the calculation — same conservative
    // behavior as before moisture tracking existed, just now opt-in per item
    // instead of silently applied to everything.
    const dryKg = moisture !== null && moisture !== undefined ? wetKg * (1 - moisture / 100) : wetKg;
    totalDryKg += dryKg;

    const carbon = it.carbon_pct_actual ?? it.carbon_pct_standard;
    const nitrogen = it.nitrogen_pct_actual ?? it.nitrogen_pct_standard;
    if (carbon !== null && carbon !== undefined) carbonWeighted += dryKg * carbon;
    if (nitrogen !== null && nitrogen !== undefined) nitrogenWeighted += dryKg * nitrogen;

    // Ash is a dry-basis percentage, so it's averaged over dry matter too.
    const ash = it.ash_pct_actual ?? it.ash_pct_standard;
    if (ash !== null && ash !== undefined) {
      ashWeighted += dryKg * ash;
      ashKnownDryKg += dryKg;
    }
  });
  const cnRatio = nitrogenWeighted > 0 ? carbonWeighted / nitrogenWeighted : null;

  // Averaged only over materials that have an ash value. Dividing by all dry
  // matter instead would count a material with no figure as 0% ash and drag the
  // result down; averaging over the known ones is closer, but can mislead if a
  // large ingredient is missing — hence ashCoverage, so the screen can say so.
  const ashPct = ashKnownDryKg > 0 ? ashWeighted / ashKnownDryKg : null;
  const ashCoverage = totalDryKg > 0 ? ashKnownDryKg / totalDryKg : null;
  // Cost efficiency is naturally against what was physically loaded (wet), not
  // the drier, lighter figure C:N math needs.
  const costPerKgCompost = totalWetKg > 0 && hasCost ? totalCostNpr / totalWetKg : null;
  return {
    totalWetKg: totalWetKg || null,
    totalDryKg: totalDryKg || null,
    totalCostNpr: hasCost ? totalCostNpr : null,
    cnRatio,
    ashPct,
    ashCoverage,
    costPerKgCompost,
  };
}

module.exports = { summarizeIntakeItems };
