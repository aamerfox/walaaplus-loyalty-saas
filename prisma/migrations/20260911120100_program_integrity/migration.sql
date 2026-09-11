-- Remediation item 4: pinned program mechanics are truly immutable.

-- 4a. RewardTier rows are part of a ProgramVersion's mechanics. Once the version leaves DRAFT,
--     tiers can be neither added, changed, moved, nor deleted. Issued cards pin the version and
--     therefore its tiers, forever.
CREATE OR REPLACE FUNCTION walaaplus_protect_reward_tier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_status "ProgramVersionStatus";
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT status INTO v_status FROM "ProgramVersion" WHERE id = NEW."programVersionId";
  ELSE
    SELECT status INTO v_status FROM "ProgramVersion" WHERE id = OLD."programVersionId";
  END IF;

  IF v_status IS DISTINCT FROM 'DRAFT'::"ProgramVersionStatus" THEN
    RAISE EXCEPTION 'RewardTier belongs to a ProgramVersion in status %; reward tiers are immutable after activation (% not permitted)',
      v_status, TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW."programVersionId" <> OLD."programVersionId" THEN
    RAISE EXCEPTION 'RewardTier % cannot move to another ProgramVersion', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER reward_tier_protect
  BEFORE INSERT OR UPDATE OR DELETE ON "RewardTier"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_protect_reward_tier();

-- 4b. ProgramTemplate.cardType locks the moment any version is activated or any card is issued.
--     A stamp program can never become a points program under existing cards.
CREATE OR REPLACE FUNCTION walaaplus_protect_template_card_type() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."cardType" <> OLD."cardType" THEN
    IF EXISTS (SELECT 1 FROM "ProgramVersion" v WHERE v."templateId" = OLD.id AND v.status <> 'DRAFT'::"ProgramVersionStatus")
       OR EXISTS (SELECT 1 FROM "CustomerCard" c WHERE c."templateId" = OLD.id) THEN
      RAISE EXCEPTION 'ProgramTemplate % cardType is locked: a version was activated or a card was issued', OLD.id
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER program_template_protect_card_type
  BEFORE UPDATE ON "ProgramTemplate"
  FOR EACH ROW EXECUTE FUNCTION walaaplus_protect_template_card_type();
