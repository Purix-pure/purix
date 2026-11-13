# Support

Purix is a pre-1.0 beta maintained by a small team. Support is best effort, with no guaranteed response time.

| You have | Go to |
|---|---|
| A bug | [GitHub Issues](https://github.com/purix-pure/purix/issues). Use the bug template. |
| A question, or an idea to float | [GitHub Discussions](https://github.com/purix-pure/purix/discussions) |
| A security vulnerability | Do not post it publicly. Use the [private reporting link](https://github.com/purix-pure/purix/security/advisories/new) described in [SECURITY.md](./SECURITY.md). |
| A privacy concern | [PRIVACY.md](./PRIVACY.md), then Discussions, or the private flow if it should not be public. |
| A conduct problem | [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) |

## Before you file a bug

1. Check you are on the latest beta: `npm install -g @purix/cli@beta`, then `purix --version`.
2. Check [BETA_SCOPE.md](./BETA_SCOPE.md). Languages other than TypeScript, JavaScript and Python are not checked, and Windows, macOS and Cursor are experimental.
3. Include: `purix --version`, `node -v`, your operating system, the package manager of the project, the coding agent you connected (if any), the command you ran, and what you expected against what happened.
4. Remove secrets and private code from anything you paste. Diagnostic logs are in `~/.purix/logs/` and can contain file paths.

Requirements: Node.js 22.13 or later (or 24+); see [docs/NODE_SUPPORT_POLICY.md](./docs/NODE_SUPPORT_POLICY.md).
