// Compute AMV using BofA value and Redfin AVM value (not listing value)
export function computeAMV({ bofa_value = null, redfin_avm_value = null } = {}) {
  const vals = [];
  if (Number.isFinite(bofa_value)) vals.push(Number(bofa_value));
  if (Number.isFinite(redfin_avm_value)) vals.push(Number(redfin_avm_value));

  if (!vals.length) return null; // neither value present
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(avg);
}