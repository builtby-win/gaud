# Gaud Pi Extension DX Improvement Plan

## Objective
Implement critical developer experience improvements to the `gaud` Pi extension based on the DX review.

## Key Files & Context
- `extensions/gaud/index.ts`: Entry point for Pi commands.
- `extensions/gaud/pollerBridge.ts`: Polling logic and error reporting.
- `README.md`: Installation and troubleshooting documentation.

## Implementation Steps
1. **Auto-Doctor**: Modify `extensions/gaud/index.ts` to run `/gaud-doctor` preflight if agent CLI is missing.
2. **Poller Health**: Update `extensions/gaud/pollerBridge.ts` to report poller failures to Pi orchestrator.
3. **Documentation**: Update `README.md` with poller troubleshooting steps.
4. **TTHW Measurement**: Add instrumentation to `extensions/gaud/pollerBridge.ts` to log time-to-first-event.

## Verification & Testing
- Run `/gaud` without agent CLI configured and verify auto-doctor runs.
- Manually kill poller and verify Pi orchestrator receives notification.
- Verify README poller troubleshooting is present.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | CLEAN | score: 7/10 → 9/10, TTHW: 5m → 2m |
