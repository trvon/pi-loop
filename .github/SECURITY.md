# Security policy

## Reporting

Report suspected vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not include secrets or exploit details in a public issue.

## Dependency policy

Release and CI gates run:

```bash
npm run audit:all
```

This audits all direct and transitive dependencies and fails on any finding. `pi-loop` ships one runtime dependency and receives Pi, Pi TUI, and TypeBox from the host through peer dependencies.

The production-only audit remains available for consumers that need to audit the published dependency set:

```bash
npm run audit:production
```

Never use `npm audit fix --force` to silence an advisory by downgrading Pi or changing its API contract. Upgrade the exact Pi and Pi TUI development pins together, regenerate the lockfile normally, run the full validation suite, and require `npm run audit:all` to return zero.
