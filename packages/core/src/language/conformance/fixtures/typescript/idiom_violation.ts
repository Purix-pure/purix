// Placeholder idiom violation (no-var). This intentionally trips ESLint's
// built-in no-var rule so idiom_check has something to find once a real
// eslint.config.js exists in the runtime workspace (see run.ts). The real
// rule set enforced here is a project house-style decision, not something
// inferred from this codebase — swap this fixture the moment that's decided.
var legacyCounter = 0;
