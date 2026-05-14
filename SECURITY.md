# Security Policy

We take reder's security seriously — it brokers access to live developer workstations, so vulnerabilities can have real blast radius. Thank you for taking the time to report responsibly.

## Supported versions

Reder is pre-1.0. Only the latest minor receives security fixes; older 0.1.x patch releases will not be back-patched.

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes (latest patch) |
| < 0.1   | No                 |

## Reporting a vulnerability

**Preferred:** open a [private security advisory on GitHub](https://github.com/RederJS/rederjs/security/advisories/new). This keeps the discussion confidential and lets us coordinate a fix and disclosure.

**Fallback:** email `ed@degrootventures.com` if you cannot use GitHub advisories.

Please do **not** file a public GitHub issue for security bugs.

### What to include

- A description of the issue and the impact you believe it has
- Steps to reproduce — ideally a minimal proof-of-concept
- Affected version(s), platform, and any relevant configuration (adapter, auth mode, etc.)
- Whether the vulnerability has already been disclosed elsewhere

### What to expect

- We acknowledge new reports within **5 business days**.
- We aim to have an initial assessment (severity, scope, likely fix path) within **10 business days**.
- We prefer **coordinated disclosure**: we will work with you on a fix, a release, and a public advisory, and we are happy to credit you in the advisory unless you ask us not to.
- Critical issues are released as patch versions of the current minor; we will not silently fix security bugs.

See [docs/security.md](docs/security.md) for the current threat model and operator-facing controls.
