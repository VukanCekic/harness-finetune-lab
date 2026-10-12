const USERS = new Map([
  [1, { id: 1, name: "Ada" }],
  [2, { id: 2, name: "Grace" }]
]);

/** The user with this id, or null. */
export function getUsr(id) {
  return USERS.get(id) ?? null;
}

// Known-wrong: the new name exists, the old one is still there and still used.
export const getUser = getUsr;
