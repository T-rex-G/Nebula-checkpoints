-- An invitation may now carry no repository scope at all, which means the
-- tester is not bound to a named repository and may work against anything
-- their own credentials reach.
--
-- The restriction lived here, not in the application: the column's inline
-- CHECK required between one and twenty scopes, so no amount of JavaScript
-- could issue an unbound invitation. Relaxing the floor to zero is the whole
-- change; the ceiling of twenty and every scoped invitation already issued
-- keep working exactly as before.
--
-- The constraint is looked up by its definition rather than by an assumed
-- name. PostgreSQL generates the name of an inline column CHECK, and a
-- DROP ... IF EXISTS against a guessed name is silent when the guess is
-- wrong -- which would leave the original constraint in place, still
-- refusing zero scopes, while this migration reported success.
LOCK TABLE nv_alpha_invites IN ACCESS EXCLUSIVE MODE;

DO $unbind$
DECLARE
  target_name text;
  dropped integer := 0;
BEGIN
  FOR target_name IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'nv_alpha_invites'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%cardinality(repository_scopes)%'
  LOOP
    EXECUTE format('ALTER TABLE nv_alpha_invites DROP CONSTRAINT %I', target_name);
    dropped := dropped + 1;
  END LOOP;

  IF dropped = 0 THEN
    RAISE EXCEPTION 'No repository_scopes cardinality constraint was found to relax';
  END IF;
END
$unbind$;

ALTER TABLE nv_alpha_invites
  ADD CONSTRAINT nv_alpha_invites_repository_scopes_card_check
  CHECK (cardinality(repository_scopes) BETWEEN 0 AND 20);
