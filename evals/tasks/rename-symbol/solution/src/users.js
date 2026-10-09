const USERS = new Map([
  [1, { id: 1, name: "Ada" }],
  [2, { id: 2, name: "Grace" }]
]);

/** The user with this id, or null. */
export function getUser(id) {
  return USERS.get(id) ?? null;
}
