import { getUsr } from "./users.js";

/** Comma-separated names for the ids; "unknown" for ids with no user. */
export function report(ids) {
  return ids.map((id) => getUsr(id)?.name ?? "unknown").join(", ");
}
