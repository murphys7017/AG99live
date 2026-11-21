import type { SemanticAxisDefinition, SemanticAxisProfile } from "../../types/semantic-axis-profile.js";
import type { ResolvedAxisRoleBuckets } from "./compileContext.js";

interface ProfileIndex {
  hash: string;
  revision: number;
  axes: SemanticAxisProfile["axes"];
  byId: Map<string, SemanticAxisDefinition>;
  roles: ResolvedAxisRoleBuckets;
  dynamicsFailure: string;
}

const indexes = new WeakMap<SemanticAxisProfile, ProfileIndex>();

export function profileIndex(profile: SemanticAxisProfile): ProfileIndex {
  const cached = indexes.get(profile);
  if (cached && cached.revision === profile.revision && cached.hash === profile.source_hash && cached.axes === profile.axes) {
    return cached;
  }
  const index: ProfileIndex = {
    revision: profile.revision, hash: profile.source_hash, axes: profile.axes, byId: new Map(),
    roles: { primaryAxes: [], hintAxes: [], derivedAxes: [], runtimeAxes: [] }, dynamicsFailure: "",
  };
  for (const axis of profile.axes) {
    index.byId.set(axis.id, axis);
    switch (axis.control_role) {
      case "primary": index.roles.primaryAxes.push(axis.id); break;
      case "hint": index.roles.hintAxes.push(axis.id); break;
      case "derived": index.roles.derivedAxes.push(axis.id); break;
      case "runtime": case "ambient": case "debug": index.roles.runtimeAxes.push(axis.id); break;
    }
    const d = axis.dynamics;
    if (!index.dynamicsFailure && (!d || !Number.isFinite(d.max_velocity) || d.max_velocity <= 0
      || !Number.isFinite(d.max_acceleration) || d.max_acceleration <= 0
      || !Number.isFinite(d.max_speech_offset_ratio) || d.max_speech_offset_ratio < 0 || d.max_speech_offset_ratio > 0.5)) {
      index.dynamicsFailure = `semantic_axis_dynamics_invalid:${axis.id}`;
    }
  }
  indexes.set(profile, index);
  return index;
}
