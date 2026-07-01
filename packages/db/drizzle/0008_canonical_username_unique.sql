-- Preflight: fail early and clearly if existing rows would collide on the
-- canonical lower(username) form, rather than aborting mid-migration on the
-- CREATE UNIQUE INDEX below (which would leave the old constraint already dropped).
DO $$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(lower_username, ', ')
    INTO collisions
    FROM (
      SELECT lower(username) AS lower_username
        FROM "users"
       GROUP BY lower(username)
      HAVING count(*) > 1
    ) dupes;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce canonical username uniqueness: case-insensitive duplicates exist (%). Resolve these before migrating.', collisions;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_username_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));