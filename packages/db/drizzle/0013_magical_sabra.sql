DO $$
DECLARE dupes text;
BEGIN
  -- The old users_email_unique was case-SENSITIVE, so case-variant duplicates of
  -- one address (alice@ / Alice@) may exist. The new lower(email) unique index
  -- would abort on them — fail early with the offending addresses instead.
  SELECT string_agg(lower(email), ', ') INTO dupes
  FROM users
  WHERE email IS NOT NULL
  GROUP BY lower(email)
  HAVING count(*) > 1;
  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce case-insensitive email uniqueness. Resolve duplicate addresses first: %', dupes;
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));