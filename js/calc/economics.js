// Economics: NPV, payback, and the incremental case for adding a battery.
//
// As of milestone 2 this works from *simulated energy flows* (see js/calc/dispatch.js)
// rather than the rule-of-thumb self-consumption curve used in milestone 1. Flows come from
// an hourly simulation, so self-consumption reflects an actual production/load overlap.

const Economics = (() => {
  // Value of one year of operation: avoided imports + export revenue, net of O&M.
  //
  // Degradation is applied to PV output only. Rather than re-running the hourly dispatch for
  // every year, the *rates* (self-consumption / self-sufficiency) from the year-0 simulation
  // are held constant and applied to the degraded output. Over a 0.5%/yr decline the rate
  // drift is far smaller than the uncertainty already present in the synthetic profiles.
  function annualCashFlow({
    flows,
    retailPrice,
    feedInTariff,
    yearIndex,
    omAnnual = 0,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    const degradation = 1 - (degradationPctPerYear / 100) * yearIndex;
    const escalation = (1 + tariffEscalationPct / 100) ** yearIndex;

    const selfConsumed = flows.selfConsumed * degradation;
    const exported = flows.exported * degradation;

    const avoidedImportValue = selfConsumed * retailPrice * escalation;
    const exportRevenue = exported * feedInTariff * escalation;

    return avoidedImportValue + exportRevenue - omAnnual;
  }

  // Undiscounted annual electricity bill given a set of flows (what the user actually pays).
  function annualBill({ flows, retailPrice, feedInTariff, fixedAnnualCharge = 0 }) {
    return flows.imported * retailPrice - flows.exported * feedInTariff + fixedAnnualCharge;
  }

  function npv({
    capex,
    flows,
    retailPrice,
    feedInTariff,
    discountRatePct,
    lifetimeYears,
    omPctOfCapex = 1,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    const omAnnual = capex * (omPctOfCapex / 100);
    let total = -capex;
    for (let y = 0; y < lifetimeYears; y++) {
      const cf = annualCashFlow({
        flows,
        retailPrice,
        feedInTariff,
        yearIndex: y,
        omAnnual,
        degradationPctPerYear,
        tariffEscalationPct,
      });
      total += cf / (1 + discountRatePct / 100) ** (y + 1);
    }
    return total;
  }

  // Simple (undiscounted) payback, walking cumulative cash flow until it turns positive.
  // Returns Infinity when it never does within the system lifetime.
  function simplePaybackYears({
    capex,
    flows,
    retailPrice,
    feedInTariff,
    lifetimeYears,
    omPctOfCapex = 1,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    const omAnnual = capex * (omPctOfCapex / 100);
    let cumulative = -capex;
    for (let y = 0; y < lifetimeYears; y++) {
      const cf = annualCashFlow({
        flows,
        retailPrice,
        feedInTariff,
        yearIndex: y,
        omAnnual,
        degradationPctPerYear,
        tariffEscalationPct,
      });
      if (cf <= 0) continue;
      if (cumulative + cf >= 0) {
        return y + -cumulative / cf;
      }
      cumulative += cf;
    }
    return Infinity;
  }

  // The battery question is incremental, not standalone: it compares a PV+battery system
  // against the same PV system without one. The battery earns only the *extra* self-consumed
  // energy it enables (which stops being exported), so its case is driven by the retail /
  // feed-in spread rather than by the retail price alone.
  function batteryIncrement({
    flowsWithout,
    flowsWith,
    batteryCapex,
    retailPrice,
    feedInTariff,
    discountRatePct,
    lifetimeYears,
    batteryLifetimeYears = null,
    omPctOfCapex = 0,
    degradationPctPerYear = 0.5,
    tariffEscalationPct = 0,
  }) {
    const extraSelfConsumed = flowsWith.selfConsumed - flowsWithout.selfConsumed;
    const lostExport = flowsWithout.exported - flowsWith.exported;

    const incrementalFlows = {
      selfConsumed: extraSelfConsumed,
      exported: -lostExport,
    };

    const horizon = batteryLifetimeYears ?? lifetimeYears;

    return {
      extraSelfConsumed,
      lostExport,
      year1Benefit: annualCashFlow({
        flows: incrementalFlows,
        retailPrice,
        feedInTariff,
        yearIndex: 0,
        omAnnual: batteryCapex * (omPctOfCapex / 100),
        degradationPctPerYear,
        tariffEscalationPct,
      }),
      npv: npv({
        capex: batteryCapex,
        flows: incrementalFlows,
        retailPrice,
        feedInTariff,
        discountRatePct,
        lifetimeYears: horizon,
        omPctOfCapex,
        degradationPctPerYear,
        tariffEscalationPct,
      }),
      paybackYears: simplePaybackYears({
        capex: batteryCapex,
        flows: incrementalFlows,
        retailPrice,
        feedInTariff,
        lifetimeYears: horizon,
        omPctOfCapex,
        degradationPctPerYear,
        tariffEscalationPct,
      }),
    };
  }

  return { annualCashFlow, annualBill, npv, simplePaybackYears, batteryIncrement };
})();
