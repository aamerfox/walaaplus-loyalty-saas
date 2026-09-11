-- Remediation item 7: UTM links are identified by NAME within a template, not by utmSource.
--
-- Several links may legitimately share one utmSource (e.g. two "instagram" links for two
-- campaigns, or two table QR codes both tagged "in-store"). What must be unique per template is
-- the human-facing name; the publicToken stays globally unique (it is what appears in the QR/URL).

DROP INDEX IF EXISTS "UtmSourceLink_templateId_utmSource_key";

CREATE UNIQUE INDEX "UtmSourceLink_templateId_name_key" ON "UtmSourceLink"("templateId", "name");
