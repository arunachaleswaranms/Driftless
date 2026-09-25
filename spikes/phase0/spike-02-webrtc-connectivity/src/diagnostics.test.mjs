import assert from "node:assert/strict";
import test from "node:test";

import {
  candidateTypeFrom,
  chooseSelectedPair,
  classifyCandidatePath,
  formatCandidateTypes,
  formatRtt,
} from "./diagnostics.mjs";

test("candidateTypeFrom uses browser fields and parses candidate text", () => {
  assert.equal(candidateTypeFrom({ type: "relay" }), "relay");
  assert.equal(candidateTypeFrom({ candidate: "candidate:1 1 UDP 1 192.0.2.1 9 typ host" }), "host");
  assert.equal(candidateTypeFrom("candidate:2 1 udp 1 198.51.100.1 9 typ srflx"), "srflx");
  assert.equal(candidateTypeFrom(null), null);
});

test("chooseSelectedPair follows the transport-selected pair", () => {
  const reports = [
    { id: "transport-1", type: "transport", selectedCandidatePairId: "pair-1" },
    {
      id: "pair-1",
      type: "candidate-pair",
      state: "succeeded",
      localCandidateId: "local-1",
      remoteCandidateId: "remote-1",
    },
    { id: "local-1", type: "local-candidate", candidateType: "host", protocol: "udp" },
    { id: "remote-1", type: "remote-candidate", candidateType: "srflx", protocol: "udp" },
  ];
  const selected = chooseSelectedPair(new Map(reports.map((report) => [report.id, report])));

  assert.equal(selected?.pair.id, "pair-1");
  assert.equal(selected?.local.candidateType, "host");
  assert.equal(selected?.remote.candidateType, "srflx");
});

test("chooseSelectedPair falls back to a nominated succeeded pair", () => {
  const selected = chooseSelectedPair([
    {
      id: "pair-2",
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "local-2",
      remoteCandidateId: "remote-2",
    },
  ]);
  assert.equal(selected?.pair.id, "pair-2");
  assert.equal(chooseSelectedPair([]), null);
});

test("path classification does not infer beyond selected candidate evidence", () => {
  assert.match(classifyCandidatePath("host", "host"), /^host/);
  assert.match(classifyCandidatePath("host", "srflx"), /^srflx/);
  assert.match(classifyCandidatePath("relay", "host"), /^relay/);
  assert.match(classifyCandidatePath("host", null), /^unavailable/);
});

test("diagnostic formatters are deterministic", () => {
  assert.equal(formatRtt(0.01234), "12.34 ms");
  assert.equal(formatRtt(undefined), "Unavailable");
  assert.equal(formatCandidateTypes(new Set(["srflx", "host"])), "host, srflx");
  assert.equal(formatCandidateTypes(new Set()), "None");
});
