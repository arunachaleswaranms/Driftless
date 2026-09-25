export function candidateTypeFrom(candidate) {
  if (!candidate) return null;
  if (typeof candidate.type === "string" && candidate.type) return candidate.type;

  const value = typeof candidate === "string" ? candidate : candidate.candidate;
  const match = typeof value === "string" ? value.match(/\btyp\s+(host|srflx|prflx|relay)\b/i) : null;
  return match ? match[1].toLowerCase() : null;
}

export function chooseSelectedPair(stats) {
  const reports =
    stats && typeof stats.values === "function"
      ? Array.from(stats.values())
      : Array.from(stats ?? []).map((item) =>
          Array.isArray(item) && item.length === 2 ? item[1] : item,
        );
  const byId = new Map(reports.map((report) => [report.id, report]));
  const transport = reports.find(
    (report) => report.type === "transport" && report.selectedCandidatePairId,
  );

  let pair = transport ? byId.get(transport.selectedCandidatePairId) : null;
  pair ??= reports.find(
    (report) =>
      report.type === "candidate-pair" &&
      report.state === "succeeded" &&
      (report.selected === true || report.nominated === true),
  );

  if (!pair) return null;

  return {
    pair,
    local: byId.get(pair.localCandidateId) ?? null,
    remote: byId.get(pair.remoteCandidateId) ?? null,
  };
}

export function classifyCandidatePath(localType, remoteType) {
  const types = [localType, remoteType].filter(Boolean);
  if (types.includes("relay")) return "relay (selected pair includes a relay candidate)";
  if (types.includes("srflx") || types.includes("prflx")) {
    return "srflx/prflx (selected pair includes a reflexive candidate)";
  }
  if (types.length === 2 && types.every((type) => type === "host")) {
    return "host (both selected candidates are host candidates)";
  }
  return "unavailable (selected candidate types incomplete)";
}

export function formatRtt(seconds) {
  return Number.isFinite(seconds) ? `${(seconds * 1000).toFixed(2)} ms` : "Unavailable";
}

export function formatCandidateTypes(types) {
  const values = Array.from(types ?? []).filter(Boolean).sort();
  return values.length > 0 ? values.join(", ") : "None";
}
