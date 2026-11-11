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
    guidance: `Investigate ineffective validation and excessive testing, including bounded deletion or consolidation of tests and test-only fixtures/helpers that add cost without distinct verification value.
- Start from current requirements, actual usage and known regressions. Find tests that only assert mock setup, mirror implementation details, duplicate the same behavior without covering a distinct risk, or preserve superseded requirements. Derive expected outcomes from the contract, not from the implementation being tested.
- E2E verification must cover the product's main UI workflows through actual entry points, navigation, user actions and observable results, including relevant persisted state. Determine coverage by the required workflows, not a target of a few tests or a readiness-only smoke check. Preserve core-flow coverage during cleanup; isolated passing units, mocked calls, seeded fixtures or directly rendered screens alone do not prove that a complete UI workflow works.
- Prefer integration tests with real collaborating components for applicable edge and corner cases and cross-component/data boundaries. Keep external, costly or nondeterministic dependencies controlled at their boundaries; do not require live third-party services or paid models.
- Reserve focused unit tests for critical logic or concrete regression risks where they add useful evidence beyond existing checks. Do not require a unit test for every function, fixed coverage percentages, test-count targets or a wholesale conversion to E2E. A test's level alone does not justify deleting it.
- Limit edge cases to applicable requirements, realistic inputs, known failures and concrete product risks. Do not expand or retain speculative matrices for impossible or negligibly likely states without a current contract or risk basis; unknown likelihood is not evidence of negligible risk. Preserve required security, data-integrity and recovery verification even for rare failures.
- For each proposed deletion or consolidation, identify the original rationale, concrete maintenance or execution cost, and which remaining evidence protects the necessary behavior or known regression. Do not replace each deleted test one-for-one when existing evidence is sufficient. Reuse still-applicable evidence and stop adding or rerunning checks once the necessary conclusion is supported, unless a change, failure or concrete regression risk warrants more.
- Still investigate weakened assertions that hide unmet requirements. Never delete a failing test or relax its expected outcome merely to make checks pass, discard necessary regression coverage, or revive superseded requirements.`,
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
