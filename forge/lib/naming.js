// Name-shape helpers for the generator. Kept tiny and dependency-free —
// this is dev-tooling, run by hand on the Mac, not fleet runtime code.

export function toKebab(input) {
  return String(input)
    .trim()
    .replace(/[_\s]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export function toCamel(kebab) {
  return kebab
    .split("-")
    .filter(Boolean)
    .map((part, i) => (i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("")
}

export function toPascal(kebab) {
  const camel = toCamel(kebab)
  return camel.charAt(0).toUpperCase() + camel.slice(1)
}

// Accepts "title,date" or "kind,title" — comma-separated flat field names.
// Deliberately does NOT support feed-radar's `{ field: "id", exact: true }`
// shape (an exact-match numeric id, one radar fleet-wide) — that is rare
// enough that the generator leaves it as a documented manual edit in the
// generated key module rather than a flag, per the same restraint that
// keeps the key FORMAT itself unstandardized (see forge/README.md).
export function parseKeyFields(raw) {
  const fields = String(raw)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
  if (fields.length === 0) {
    throw new Error("--key-fields must list at least one field, e.g. --key-fields title,date")
  }
  return fields
}

export function jsStringArray(fields) {
  return `[${fields.map((f) => JSON.stringify(f)).join(", ")}]`
}
