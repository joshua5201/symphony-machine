export const maintenanceDirections = [
  {
    id: "unnecessary-abstraction",
    focus: "Unnecessary abstractions",
    guidance: "Investigate layers, adapters, extension mechanisms and configuration added without a current requirement. A single implementation alone does not prove an abstraction unnecessary; check callers and the original design rationale.",
  },
  {
    id: "defensive-fallbacks",
    focus: "Excessive defenses and misleading fallbacks",
    guidance: "Investigate swallowed failures, errors converted into success or empty results, and redundant defenses. Preserve intentional recovery, boundary validation and operational safeguards; establish the actual failure behavior before proposing removal.",
  },
  {
    id: "duplicate-implementation",
    focus: "Duplicate implementations",
    guidance: "Investigate newly reinvented existing capabilities and duplicated implementations of the same contract. Similar-looking code with different contracts is not sufficient evidence for consolidation.",
  },
  {
    id: "incomplete-replacement",
    focus: "Incomplete replacements",
    guidance: "Investigate old paths, configuration and dependencies left behind by a completed replacement or removed feature. Confirm consumers, dynamic usage and compatibility obligations before declaring anything obsolete.",
  },
  {
    id: "redundant-state",
    focus: "Redundant state",
    guidance: "Investigate duplicated sources of truth or stored values that require avoidable synchronization. Check persistence, caching and recovery contracts before concluding that derived state can replace them.",
  },
  {
    id: "ineffective-validation",
    focus: "Ineffective validation",
    guidance: "Investigate tests that only assert mock behavior or implementation details, and weakened assertions that hide unmet requirements. Identify the current behavior or known regression that should be verified; do not inflate test counts or revive superseded requirements.",
  },
  {
    id: "documentation-drift",
    focus: "Documentation drift",
    guidance: "Investigate comments and usage documentation that contradict current behavior. Check the authoritative requirement before deciding whether the code or documentation is wrong; do not silently rewrite requirements to match implementation.",
  },
] as const;

export type MaintenanceScan = {
  direction: (typeof maintenanceDirections)[number]["id"];
  from?: string;
  to: string;
};
