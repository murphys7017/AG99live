import type { DesktopBaseActionPreview } from "../types/desktop";
import type {
  ParameterActionAtom,
  ParameterActionLibrary,
  RuntimeCacheErrorsPayload,
} from "../types/protocol";

export function buildParameterActionPreview(
  library: ParameterActionLibrary | null | undefined,
  runtimeCacheErrors?: RuntimeCacheErrorsPayload | null,
): DesktopBaseActionPreview | null {
  if (!library) {
    return null;
  }

  const runtimeCacheDiagnostics = buildRuntimeCacheDiagnostics(runtimeCacheErrors);
  const channelCandidateCountByName = new Map<string, number>();
  for (const item of library.channels) {
    channelCandidateCountByName.set(
      item.name,
      Number.isFinite(item.count) ? item.count : 0,
    );
  }

  const channelAtomIdsByName = new Map<string, string[]>();
  const channelDomainByName = new Map<string, string>();
  const channelPolarityByName = new Map<string, Set<string>>();
  const mappedAtoms = library.atoms
    .map((atom) =>
      mapParameterActionAtom(
        atom,
        channelAtomIdsByName,
        channelDomainByName,
        channelPolarityByName,
      ),
    )
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.energyScore !== left.energyScore) {
        return right.energyScore - left.energyScore;
      }
      return left.id.localeCompare(right.id);
    });

  const orderedChannelNames = uniqueStrings([
    ...library.channels.map((item) => item.name),
    ...channelAtomIdsByName.keys(),
  ]);
  const channels = orderedChannelNames.map((channelName) => {
    const atomIds = channelAtomIdsByName.get(channelName) ?? [];
    return {
      name: channelName,
      label: formatLabelFromKey(channelName, "parameter"),
      family: "parameter",
      familyLabel: "parameter",
      domain: channelDomainByName.get(channelName) ?? "other",
      available: true,
      candidateComponentCount: channelCandidateCountByName.get(channelName) ?? atomIds.length,
      selectedAtomCount: atomIds.length,
      polarityModes: [...(channelPolarityByName.get(channelName) ?? new Set<string>())],
      atomIds: [...atomIds],
    };
  });

  const families = buildParameterFamilies(library);
  const selectedChannelCount = channels.filter(
    (channel) => channel.selectedAtomCount > 0,
  ).length;

  return {
    schemaVersion: library.schema_version,
    extractionMode: library.extraction_mode,
    focusChannels: library.channels.map((item) => item.name),
    focusDomains: library.domains.map((item) => item.name),
    ignoredDomains: [],
    summary: {
      motionCount: library.summary.motion_count,
      availableChannelCount: channels.length,
      selectedChannelCount,
      candidateComponentCount: library.summary.driver_component_count,
      selectedAtomCount: library.summary.selected_atom_count,
      familyCount: library.summary.selected_parameter_count,
    },
    analysis: {
      status: library.analysis.status,
      mode: library.analysis.mode,
      providerId: library.analysis.provider_id,
      inputSignature: "",
      latencyMs: 0,
      cacheHit: false,
      selectedChannelCount,
      error: [library.analysis.error ?? "", runtimeCacheDiagnostics].filter(Boolean).join(" | "),
      fallbackReason: "",
    },
    families,
    channels,
    atoms: mappedAtoms,
  };
}

function mapParameterActionAtom(
  atom: ParameterActionAtom,
  channelAtomIdsByName: Map<string, string[]>,
  channelDomainByName: Map<string, string>,
  channelPolarityByName: Map<string, Set<string>>,
): DesktopBaseActionPreview["atoms"][number] {
  const atomChannels = uniqueStrings([...(atom.channels ?? [])]);
  const channel = resolvePrimaryChannel(atom.primary_channel ?? "", atomChannels);
  const polarity = atom.polarity || "neutral";
  const channelLabel = formatLabelFromKey(channel, "parameter");
  const family = atom.kind || "parameter";
  const familyLabel = formatLabelFromKey(family, "parameter");

  const nextAtomIds = channelAtomIdsByName.get(channel) ?? [];
  nextAtomIds.push(atom.id);
  channelAtomIdsByName.set(channel, nextAtomIds);
  if (!channelDomainByName.get(channel)) {
    channelDomainByName.set(channel, atom.domain || "other");
  }
  const polarityModes = channelPolarityByName.get(channel) ?? new Set<string>();
  polarityModes.add(polarity);
  channelPolarityByName.set(channel, polarityModes);

  return {
    id: atom.id,
    name: atom.name,
    label: atom.label,
    channel,
    channelLabel,
    family,
    familyLabel,
    domain: atom.domain || "other",
    polarity,
    semanticPolarity: atom.semantic_polarity || polarity,
    trait: atom.trait,
    strength: atom.strength,
    score: atom.score,
    energyScore: atom.energy_score,
    primaryParameterMatch: true,
    channelPurity: atomChannels.length ? 1 / atomChannels.length : 1,
    sourceMotion: atom.source_motion,
    sourceFile: atom.source_file,
    sourceGroup: atom.source_group,
    sourceCategory: atom.source_category,
    sourceTags: [...atom.source_tags],
    duration: atom.duration,
    fps: atom.fps,
    loop: atom.loop,
    intensity: atom.intensity,
  };
}

function buildParameterFamilies(
  library: ParameterActionLibrary,
): DesktopBaseActionPreview["families"] {
  const familyAccumulator = new Map<
    string,
    { channels: Set<string>; atomCount: number }
  >();
  for (const parameter of library.parameters) {
    const kind = (parameter.kind || "parameter").trim() || "parameter";
    const current = familyAccumulator.get(kind) ?? {
      channels: new Set<string>(),
      atomCount: 0,
    };
    for (const channel of parameter.channels ?? []) {
      if (channel.trim()) {
        current.channels.add(channel.trim());
      }
    }
    current.atomCount += Number(parameter.selected_atom_count || 0);
    familyAccumulator.set(kind, current);
  }
  return [...familyAccumulator.entries()].map(([name, value]) => ({
    name,
    label: formatLabelFromKey(name, "parameter"),
    channels: [...value.channels],
    atomCount: value.atomCount,
  }));
}

function buildRuntimeCacheDiagnostics(
  runtimeCacheErrors?: RuntimeCacheErrorsPayload | null,
): string {
  return [
    runtimeCacheErrors?.scan_cache
      ? `runtime cache scan_cache 异常：${runtimeCacheErrors.scan_cache}`
      : "",
    runtimeCacheErrors?.action_filter_cache
      ? `runtime cache action_filter_cache 异常：${runtimeCacheErrors.action_filter_cache}`
      : "",
  ].filter(Boolean).join(" | ");
}

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].filter((item) => item.trim()))];
}

function formatLabelFromKey(key: string, fallback: string): string {
  const normalized = key.trim();
  if (!normalized) {
    return fallback;
  }
  return normalized
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolvePrimaryChannel(
  primaryChannel: string,
  channels: string[],
): string {
  const normalizedPrimary = primaryChannel.trim();
  if (normalizedPrimary) {
    return normalizedPrimary;
  }
  const first = channels.find((item) => item.trim());
  return first?.trim() || "parameter";
}
