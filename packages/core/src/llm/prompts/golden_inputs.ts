// Fixed inputs shared by the golden-capture script and the byte-identity test (ADR-054).
export const GOLDEN_INPUTS = {
  componentName: "billing-service",
  componentId: "billing-service",
  intent: "round invoice totals in billing-service to 2 decimals",
  instruction: "round the invoice total to 2 decimals",
  files: [
    { path: "src/billing.ts", content: "export function total(items: number[]): number {\n  return items.reduce((a, b) => a + b, 0);\n}\n" },
    { path: "src/config.ts", content: "export const TAX_RATE = 0.2;\n" },
  ],
  memory: ["Prefer integer cents for money", "Never log card numbers"],
  diff: [
    { path: "src/billing.ts", old_content: "export const a = 1;\n", new_content: "export const a = 2;\n", status: "modified" as const },
    { path: "src/new.ts", old_content: null, new_content: "export const b = 3;\n", status: "added" as const },
  ],
  tscError: "src/billing.ts(2,3): error TS2322: Type 'string' is not assignable to type 'number'.",
  neighbors: [{ component_id: "tax-service", path: "src/tax.ts", content: "export const RATE = 0.2;\n" }],
};
