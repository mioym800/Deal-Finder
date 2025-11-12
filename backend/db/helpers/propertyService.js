import Property from '../../models/Property.js';

// Normalize helper: turn "" or "Not found" into null; otherwise return value
const norm = (v) => (v === '' || v === 'Not found' ? null : v);

/**
 * Update agent info by fullAddress (case-insensitive supported via fullAddress_ci).
 * Writes BOTH the new camelCase fields and the legacy snake_case fields so
 * the rest of the app (and older UIs) continue to see data.
 */
export async function updatePropertyAgentInfo(fullAddress, agent = {}) {
  try {
    const fa = String(fullAddress || '').trim();
    if (!fa) throw new Error('fullAddress required');

    const fa_ci = fa.toLowerCase();

    const $set = {
      // New preferred fields (camelCase)
      agentName:            norm(agent.agentName),
      agentFirstName:       norm(agent.agentFirstName),
      agentLastName:        norm(agent.agentLastName),
      agentPhone:           norm(agent.agentPhone),
      agentEmail:           norm(agent.agentEmail),
      agentCompany:         norm(agent.agentCompany),
      agentSources:         Array.isArray(agent.agentSources) ? agent.agentSources : (Array.isArray(agent.sources) ? agent.sources : []),
      agentVerification:    norm(agent.agentVerification ?? agent.verification) || 'unverified',
      agentDateChecked:     norm(agent.agentDateChecked ?? agent.dateChecked),
      agentEmailCandidates: Array.isArray(agent.agentEmailCandidates) ? agent.agentEmailCandidates : [],

      // Legacy fields kept in sync (snake_case)
      agent:        norm(agent.agentName),
      agent_phone:  norm(agent.agentPhone),
      agent_email:  norm(agent.agentEmail),
    };

    const updated = await Property.findOneAndUpdate(
      { $or: [{ fullAddress_ci: fa_ci }, { fullAddress: fa }] },
      { $set },
      { new: true }
    );

    return updated;
  } catch (error) {
    console.error(`❌ Failed to update agent info for ${fullAddress}:`, error);
    return null;
  }
}

/**
 * Update agent info by Mongo _id (preferred when you already know the id).
 * Also writes BOTH camelCase and snake_case fields.
 */
export async function updatePropertyAgentInfoById(id, agent = {}) {
  try {
    if (!id) throw new Error('id required');

    const $set = {
      // New preferred fields (camelCase)
      agentName:            norm(agent.agentName),
      agentFirstName:       norm(agent.agentFirstName),
      agentLastName:        norm(agent.agentLastName),
      agentPhone:           norm(agent.agentPhone),
      agentEmail:           norm(agent.agentEmail),
      agentCompany:         norm(agent.agentCompany),
      agentSources:         Array.isArray(agent.agentSources) ? agent.agentSources : (Array.isArray(agent.sources) ? agent.sources : []),
      agentVerification:    norm(agent.agentVerification ?? agent.verification) || 'unverified',
      agentDateChecked:     norm(agent.agentDateChecked ?? agent.dateChecked),
      agentEmailCandidates: Array.isArray(agent.agentEmailCandidates) ? agent.agentEmailCandidates : [],

      // Legacy fields kept in sync (snake_case)
      agent:        norm(agent.agentName),
      agent_phone:  norm(agent.agentPhone),
      agent_email:  norm(agent.agentEmail),
    };

    const updated = await Property.findByIdAndUpdate(
      id,
      { $set },
      { new: true }
    );

    return updated;
  } catch (error) {
    console.error(`❌ Failed to update agent info by id ${id}:`, error);
    return null;
  }
}
