# Development Rules (priming-cost fixture)

- Every ticket transitions to `inprogress` before its first commit and to `complete` in the same commit as the code change.
- No `Co-Authored-By` trailers.
- TDD: tests proven RED before implementation, every time.
- Never edit an existing handover file; handovers are append-only.
