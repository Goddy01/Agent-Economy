# Security

This document describes the dependency security posture of this project for reviewers (e.g. Solana bounty evaluation).

## Summary

- **Runtime-relevant vulnerabilities:** Addressed. The only high-severity dependency that could be reached at runtime (buffer overflow in `bigint-buffer`) has been mitigated via a pinned override to a patched implementation.
- **Remaining `npm audit` findings:** Build-time only (not in application runtime). They are documented below and do not affect the security of the running application.

## Dependency security measures

1. **Lockfile**  
   `package-lock.json` is committed. Install with `npm ci` for reproducible, auditable dependency trees.

2. **Runtime vulnerability mitigation (bigint-buffer)**  
   The Solana/Orca stack transitively depends on `bigint-buffer`, which had a high-severity buffer overflow (CVE-2025-3194 / GHSA-3gc7-fjrx-p6mg) in `toBigIntLE()`. The upstream patched version was not yet published under the same package name, so we use an npm override so that **all** consumers of `bigint-buffer` receive the patched implementation:

   ```json
   "overrides": {
     "bigint-buffer": "npm:bigint-buffer-fixed@1.1.6"
   }
   ```

   This ensures that `@solana/buffer-layout-utils` and any other dependency that `require("bigint-buffer")` use the fixed code at runtime.

3. **Remaining audit findings (tar / node-gyp)**  
   `npm audit` may still report high-severity issues in the **tar** package. The dependency chain is:

   ```
   tar ← cacache ← make-fetch-happen ← node-gyp ← bigint-buffer-fixed
   ```

   - **When these run:** Only during `npm install` when native addons are built (e.g. optional native bindings for `bigint-buffer-fixed`). They are **not** used when the application runs.
   - **Attack surface:** These tar advisories concern extraction of archives (path traversal, symlink poisoning, etc.). They could only be relevant if a malicious tarball were extracted during install (e.g. supply-chain compromise). They are **not** reachable by network requests or user input to the application.
   - **Why not fixed:** The vulnerable `tar` version is pinned by `node-gyp` (used by `bigint-buffer-fixed`). Updating it is outside this project’s control without removing the override or changing Solana/Orca dependencies.

   For bounty evaluation: these findings do **not** affect the security of the running Solana application.

## Recommendations for reviewers

- Run `npm ci` and then `npm audit` to reproduce the reported state.
- Confirm that no runtime code path uses `tar`, `node-gyp`, or `cacache`; the only high-severity runtime dependency (bigint-buffer) is overridden to a patched version.

## Reporting vulnerabilities

If you find a vulnerability in this project (code or dependencies), please report it responsibly (e.g. via the bounty program or a private channel as specified in the bounty rules).
