// Weighted-average C:N ratio: sum(dry_kg * C%) / sum(dry_kg * N%). Uses the
// actual/tested value when present, falling back to the material's standard %.
function summarizeIntakeItems(items) {
  let totalDryKg = 0;
  let totalCostNpr = 0;
  let hasCost = false;
  let carbonWeighted = 0;
  let nitrogenWeighted = 0;
  items.forEach((it) => {
    const qty = it.qty_kg || 0;
    totalDryKg += qty;
    if (it.cost_per_kg_npr !== null && it.cost_per_kg_npr !== undefined) {
      hasCost = true;
      totalCostNpr += qty * it.cost_per_kg_npr;
    }
    const carbon = it.carbon_pct_actual ?? it.carbon_pct_standard;
    const nitrogen = it.nitrogen_pct_actual ?? it.nitrogen_pct_standard;
    if (carbon !== null && carbon !== undefined) carbonWeighted += qty * carbon;
    if (nitrogen !== null && nitrogen !== undefined) nitrogenWeighted += qty * nitrogen;
  });
  const cnRatio = nitrogenWeighted > 0 ? carbonWeighted / nitrogenWeighted : null;
  const costPerKgCompost = totalDryKg > 0 && hasCost ? totalCostNpr / totalDryKg : null;
  return {
    totalDryKg: totalDryKg || null,
    totalCostNpr: hasCost ? totalCostNpr : null,
    cnRatio,
    costPerKgCompost,
  };
}

module.exports = { summarizeIntakeItems };
