# Session Handover - W2 experiment armed, coverage check pending

Reproduces the ORACLE (broker) field case from ISS-1154: the latest handover
carried an explicit continuation list naming the actual next thread, but the
`/story` priming load led with a tracker-ranked recommend table instead and
the owner had to say "check the last few handovers" before the agent found
it. This fixture proves the shared parser extracts the continuation items
correctly, independent of how the caller (ISS-1154's recommend half, not in
scope for this ticket) later chooses to surface them.

## Next

- ISS-439: W2 experiment armed, first prediction outcomes due 2026-09-03.
- T-344: coverage check outstanding before the experiment window closes.
