import type { User } from "@bunbooru/db";

/**
 * Authorization predicates. PR A gates writes on "is authenticated" only
 * (booru-collaborative editing); the ownership/role helpers are provided for the
 * PR B superadmin work (tag-category management, tightened edit routes) and are
 * intentionally not yet enforced on the edit routes.
 */

/** Any authenticated user may perform writes (PR A policy). */
export function canWrite(user: User | null): boolean {
  return user !== null;
}

/** Admin-only actions (reserved for PR B: tag categories, runtime settings). */
export function canModerate(user: User | null): boolean {
  return user?.role === "admin";
}

/** Whether `user` owns the resource (`ownerId`) or is an admin. */
export function isOwnerOrAdmin(user: User, ownerId: number | null): boolean {
  return user.role === "admin" || (ownerId !== null && user.id === ownerId);
}
