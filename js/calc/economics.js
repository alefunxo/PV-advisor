// Milestone 1 economics: PV-only, no battery, no toggles.
// Self-consumption is estimated with a rule-of-thumb saturating curve against the
// PV-production/consumption ratio (r) — a standard approximation used by quick residential
// solar calculators when no hourly load/production overlap is available yet.
// This is explicitly a placeholder: milestone 3 (base load profile) replaces it with a real
// monthly/daily overlap calculation. Flag this heuristic to the user in the results UI.

const Economics = (() => {
  // Self-consumption fraction of PV production, without a battery, as a function of
  // r = annual PV production / annual consumption. Calibrated to typical residential
  // rule-of-thumb curves (e.g. ~30% self-consumption at r=1, higher for undersized systems,
  // lower for oversized ones).
  function selfConsumptionFraction(r) {
    if (r <= 0) return 1;
    return 1 / (1 + 2.3 * r);
  }

  function selfSufficiencyFraction(r) {
    return Math.min(1, selfConsumptionFraction(r) * r);
  }

  // Annual bill savings from PV in year `yearIndex` (0-based), given degradation and tariff escalation.
  function annualSavings({
    productionYear0,
    consumption,
    retailPrice,
    feedInTariff,
    yearIndex,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    const production = productionYear0 * (1 - (degradationPctPerYear / 100) * yearIndex);
    const r = production / consumption;
    const selfConsumed = selfConsumptionFraction(r) * production;
    const exported = production - selfConsumed;

    const escalatedRetail = retailPrice * (1 + tariffEscalationPct / 100) ** yearIndex;
    const escalatedFeedIn = feedInTariff * (1 + tariffEscalationPct / 100) ** yearIndex;

    return selfConsumed * escalatedRetail + exported * escalatedFeedIn;
  }

  function npv({
    capex,
    productionYear0,
    consumption,
    retailPrice,
    feedInTariff,
    discountRatePct,
    lifetimeYears,
    omPctOfCapex = 1,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    let total = -capex;
    const omAnnual = capex * (omPctOfCapex / 100);
    for (let y = 0; y < lifetimeYears; y++) {
      const savings = annualSavings({
        productionYear0,
        consumption,
        retailPrice,
        feedInTariff,
        yearIndex: y,
        degradationPctPerYear,
        tariffEscalationPct,
      });
      const netCashFlow = savings - omAnnual;
      total += netCashFlow / (1 + discountRatePct / 100) ** (y + 1);
    }
    return total;
  }

  // Simple (undiscounted) payback in years, based on year-1 savings held constant.
  // Returns Infinity if year-1 savings are zero or negative.
  function simplePaybackYears({ capex, productionYear0, consumption, retailPrice, feedInTariff }) {
    const year1Savings = annualSavings({
      productionYear0,
      consumption,
      retailPrice,
      feedInTariff,
      yearIndex: 0,
    });
    return year1Savings > 0 ? capex / year1Savings : Infinity;
  }

  return { selfConsumptionFraction, selfSufficiencyFraction, annualSavings, npv, simplePaybackYears };
})();
