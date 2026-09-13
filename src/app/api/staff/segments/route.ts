import { NextResponse } from "next/server";
import { z } from "zod";
import { ValidationError } from "@/server/errors";
import { errorResponse, readJsonObject } from "@/server/http";
import { conditionSchema, SEGMENT_DEFINITION_VERSION, MAX_CONDITIONS } from "@/server/segments/definition";
import { countSegment, createSegment, setSegmentArchived, updateSegment } from "@/server/segments/segments";
import { requireScannerContext } from "@/server/tenant/scanner-context";

/**
 * POST /api/staff/segments — save, change, archive and preview customer segments.
 *
 * The definition is parsed **twice**: by the strict schema here, so a body carrying an unknown field
 * or an unknown operator is refused before any service runs, and again by `parseDefinition` inside
 * the service, which is the authority. Two checks that agree cost nothing; one check a caller can
 * route around is not a check.
 *
 * Nothing here builds a query. A definition is a small validated object — it is never SQL, never a
 * Prisma fragment, and never a list of customers — and `toProfileWhere` is the only thing that turns
 * one into a query, scoped by business at every level.
 *
 * `count` takes a definition rather than a saved id on purpose: it is what the editor calls to show
 * a merchant how many people they just described, before they decide whether to keep it.
 */

const business = z.string().min(1).optional();
const segmentId = z.string().min(1).max(64);
const name = z.string().trim().min(1).max(80);

const definitionSchema = z.strictObject({
  version: z.literal(SEGMENT_DEFINITION_VERSION),
  match: z.enum(["all", "any"]),
  conditions: z.array(conditionSchema).min(1).max(MAX_CONDITIONS),
});

const bodySchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), businessId: business, name, definition: definitionSchema }),
  z.strictObject({
    action: z.literal("update"),
    businessId: business,
    segmentId,
    name: name.optional(),
    definition: definitionSchema.optional(),
  }),
  z.strictObject({ action: z.literal("archive"), businessId: business, segmentId }),
  z.strictObject({ action: z.literal("restore"), businessId: business, segmentId }),
  z.strictObject({ action: z.literal("count"), businessId: business, definition: definitionSchema }),
]);

export async function POST(req: Request) {
  try {
    const parsed = bodySchema.safeParse(await readJsonObject(req));
    if (!parsed.success) throw new ValidationError("Invalid segment request", parsed.error.issues);
    const input = parsed.data;

    const { ctx } = await requireScannerContext(input.businessId ?? null);

    switch (input.action) {
      case "create":
        return NextResponse.json(await createSegment(ctx, { name: input.name, definition: input.definition }), { status: 201 });
      case "update":
        return NextResponse.json(
          await updateSegment(ctx, input.segmentId, {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.definition !== undefined ? { definition: input.definition } : {}),
          }),
          { status: 200 },
        );
      case "archive":
        return NextResponse.json(await setSegmentArchived(ctx, input.segmentId, true), { status: 200 });
      case "restore":
        return NextResponse.json(await setSegmentArchived(ctx, input.segmentId, false), { status: 200 });
      case "count":
        return NextResponse.json(await countSegment(ctx, input.definition), { status: 200 });
    }
  } catch (e) {
    return errorResponse(e);
  }
}
