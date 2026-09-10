// packages/core/src/language/conformance/provenance.ts

export interface FixtureProvenance {
  author: string;
  reviewer: string;
  date: string | null;
  description: string;
}

export const FIXTURE_PROVENANCE: Record<string, FixtureProvenance> = {
  typescript: {
    author: "unreviewed",
    reviewer: "none",
    date: null,
    description: "Fixture set has NOT yet been through a hand-review pass.",
  },
  python: {
    author: "unreviewed",
    reviewer: "none",
    date: null,
    description: "Fixture set has NOT yet been through a hand-review pass.",
  },
  rust: {
    author: "unreviewed",
    reviewer: "none",
    date: null,
    description: "Fixture set has NOT yet been through a hand-review pass.",
  },
  go: {
    author: "unreviewed",
    reviewer: "none",
    date: null,
    description: "Fixture set has NOT yet been through a hand-review pass.",
  },
  ruby: {
    author: "unreviewed",
    reviewer: "none",
    date: null,
    description: "Fixture set has NOT yet been through a hand-review pass.",
  },
};
