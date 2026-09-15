import { HubSpotDealProperties } from "../clients/hubspotClient";
import { DotloopLoopDetail, DotloopLoopSummary } from "../clients/dotloopClient";
import { DotloopTransactionType, PipelineConfig } from "../db/types";
import { logger } from "../utils/logger";

/**
 * Dotloop loop status is scoped to a transactionType. The vocabulary below
 * was confirmed live (opening a real loop of each transaction type in the
 * Dotloop UI and reading its Status dropdown) — do not trust the enum-style
 * names Dotloop's own docs imply (PRE_OFFER, SOLD, ARCHIVED, ...), the
 * actual values are the display strings below:
 *   PURCHASE_OFFER:    Pre-Offer | Under Contract | Withdrawn | Sold | Terminated | Archived
 *   LISTING_FOR_SALE:  Pre-Listing | Private Listing | Active Listing | Under Contract | Withdrawn | Sold | Terminated | Archived
 *   LISTING_FOR_LEASE: Pre-Listing | Private Listing | Active Listing | Under Contract | Withdrawn | Leased | Terminated | Archived
 *   LEASE_OFFER:       Pre-Offer | Under Contract | Withdrawn | Leased | Terminated | Archived
 * This part of the vocabulary is Dotloop-wide and applies to every tenant.
 *
 * HubSpot deal stages, by contrast, are custom per-*portal* internal ids
 * (not the label you see in the UI) scoped to a specific pipeline, and
 * every customer's portal has its own set. So unlike the vocabulary above,
 * the actual pipeline/stage <-> status mapping (PipelineConfig[], defined
 * in db/types.ts) is per-tenant data, not a constant -- see
 * TenantRow.pipelinesConfig, populated per customer in the `tenants` table
 * (migrations/002_tenants.sql seeds Mason's own three pipelines onto the
 * `tenant_default` row; a new customer's pipelines are added the same way,
 * by editing that row's pipelines_config -- see the "no self-serve wizard
 * yet" decision in the public-distribution roadmap doc). Every function
 * below that needs this mapping takes the tenant's `pipelines` array as an
 * explicit parameter rather than closing over a module-level constant.
 *
 * The stage<->status mapping has to be pipeline-aware in both directions:
 *
 *  - HubSpot -> Dotloop (a specific dealstage always implies exactly one
 *    status) is unambiguous — see stageToStatus below.
 *  - Dotloop -> HubSpot (a status alone doesn't say which pipeline, or
 *    which stage within that pipeline, since several stages in the same
 *    pipeline can share one status — e.g. a Buyer-style pipeline's
 *    "Engaging", "Qualified" and "Preview Properties" might ALL be
 *    "Pre-Offer") needs the deal's pipeline as extra context, plus a
 *    documented tie-break for the still-ambiguous same-pipeline case. See
 *    resolveStageForStatus below and how dealLoopSync.ts supplies that
 *    pipeline context.
 *
 * When onboarding a new customer, populate their pipelines_config with
 * that portal's real pipeline internal ID (Settings -> Objects -> Deals ->
 * Pipelines) and dealstage internal IDs, and confirm the transactionType
 * correspondence with whoever owns their Dotloop account — pipeline
 * naming alone is a reasonable guess but not a guarantee.
 */

export const DEFAULT_TRANSACTION_TYPE: DotloopTransactionType = "PURCHASE_OFFER";

export function getPipelineForStageId(pipelines: PipelineConfig[], stageId: string): PipelineConfig | undefined {
  return pipelines.find((p) => p.stages.some((s) => s.id === stageId));
}

export function getPipelineById(pipelines: PipelineConfig[], pipelineId: string | undefined): PipelineConfig | undefined {
  if (!pipelineId) return undefined;
  return pipelines.find((p) => p.pipelineId === pipelineId);
}

export function getPipelineForTransactionType(
  pipelines: PipelineConfig[],
  transactionType: string | undefined
): PipelineConfig | undefined {
  if (!transactionType) return undefined;
  return pipelines.find((p) => p.transactionType === transactionType);
}

/**
 * Resolves which HubSpot stage a deal should move to for a given Dotloop
 * status, within a specific (already-known) pipeline.
 *
 * Because Dotloop's status vocabulary is coarser than HubSpot's stage
 * vocabulary, several stages in the same pipeline can share one status —
 * that many-to-one mapping is inherent to how a funnel is designed, not
 * something more data can fully undo. This is therefore a best-effort
 * resolution, not a perfect inverse of stageToStatus, and applies a
 * documented tie-break:
 *
 *   1. If the deal's current stage already maps to the target status,
 *      keep it. This avoids yanking a deal backward to some earlier
 *      same-status stage on every sync cycle just because Dotloop's
 *      status hasn't changed.
 *   2. Otherwise, prefer the LAST candidate stage in the pipeline's
 *      funnel order (PipelineConfig.stages order == HubSpot's own stage
 *      order) — i.e. the furthest-along stage carrying that status —
 *      since a Dotloop status change normally reflects forward progress.
 *   3. If no stage in this pipeline maps to the target status at all
 *      (e.g. an unrecognized/new Dotloop status), returns undefined so
 *      the caller can leave dealstage untouched rather than guess.
 */
export function resolveStageForStatus(
  pipeline: PipelineConfig,
  status: string,
  currentStageId?: string
): string | undefined {
  if (currentStageId) {
    const current = pipeline.stages.find((s) => s.id === currentStageId);
    if (current && current.status === status) return current.id;
  }
  const candidates = pipeline.stages.filter((s) => s.status === status);
  if (candidates.length === 0) return undefined;
  return candidates[candidates.length - 1].id;
}

/** dealstageId -> status, scanning every pipeline in this tenant's config.
 *  Unambiguous: a given dealstage id belongs to exactly one pipeline and
 *  always implies the same status, so this direction needs no extra
 *  context beyond the tenant's own pipelines. */
function stageToStatus(pipelines: PipelineConfig[], stageId: string): string | undefined {
  for (const pipeline of pipelines) {
    const stage = pipeline.stages.find((s) => s.id === stageId);
    if (stage) return stage.status;
  }
  return undefined;
}

export interface CanonicalDeal {
  name: string;
  status: string; // dotloop loop status vocabulary; "" if unresolved
  purchasePrice: string; // numeric string, no currency symbol
  closingDate: string; // MM/DD/YYYY (dotloop's expected format)
}

export function fromHubSpotDeal(pipelines: PipelineConfig[], props: HubSpotDealProperties): CanonicalDeal {
  const status = (props.dealstage && stageToStatus(pipelines, props.dealstage)) || "";
  if (props.dealstage && !status) {
    logger.warn({ dealstage: props.dealstage }, "Deal stage has no entry in this tenant's pipelines; leaving status unset");
  }
  return {
    name: props.dealname ?? "",
    status,
    purchasePrice: props.amount ?? "",
    closingDate: props.closedate ? isoToMDY(props.closedate) : "",
  };
}

/**
 * `context` disambiguates which pipeline/stage a Dotloop status maps back
 * to — see resolveStageForStatus. Callers (dealLoopSync.ts) are
 * responsible for determining pipelineId: the deal's existing `pipeline`
 * property when updating a deal that already has one, or the pipeline
 * implied by the loop's transactionType when creating a brand-new deal.
 */
export function toHubSpotDealProperties(
  pipelines: PipelineConfig[],
  c: CanonicalDeal,
  context: { pipelineId?: string; currentStageId?: string } = {}
): HubSpotDealProperties {
  const pipeline = getPipelineById(pipelines, context.pipelineId);
  let dealstage: string | undefined;
  if (c.status && pipeline) {
    dealstage = resolveStageForStatus(pipeline, c.status, context.currentStageId);
    if (!dealstage) {
      logger.warn(
        { pipelineId: context.pipelineId, status: c.status },
        "Dotloop status has no matching stage in this pipeline; leaving dealstage untouched"
      );
    }
  } else if (c.status && !pipeline) {
    logger.warn(
      { pipelineId: context.pipelineId },
      "No known pipeline for this deal; leaving dealstage untouched (dealstage would otherwise be ambiguous)"
    );
  }
  return {
    dealname: c.name,
    pipeline: context.pipelineId,
    dealstage,
    amount: c.purchasePrice,
    closedate: c.closingDate ? mdyToIso(c.closingDate) : undefined,
  };
}

export function fromDotloopLoop(summary: DotloopLoopSummary, detail: DotloopLoopDetail): CanonicalDeal {
  return {
    name: summary.name ?? "",
    status: summary.status ?? "",
    purchasePrice: detail?.["Financials"]?.["Purchase/Sale Price"] ?? "",
    closingDate: detail?.["Contract Dates"]?.["Closing Date"] ?? "",
  };
}

export function toDotloopLoopSummary(c: CanonicalDeal): Partial<DotloopLoopSummary> {
  const summary: Partial<DotloopLoopSummary> = { name: c.name };
  if (c.status) summary.status = c.status;
  return summary;
}

export function toDotloopLoopDetail(c: CanonicalDeal): DotloopLoopDetail {
  const detail: DotloopLoopDetail = {};
  if (c.purchasePrice) detail["Financials"] = { "Purchase/Sale Price": c.purchasePrice };
  if (c.closingDate) detail["Contract Dates"] = { "Closing Date": c.closingDate };
  return detail;
}

function isoToMDY(iso: string): string {
  // HubSpot closedate is midnight-UTC ms epoch or ISO date; handle both.
  const d = /^\d+$/.test(iso) ? new Date(Number(iso)) : new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function mdyToIso(mdy: string): string {
  const [mm, dd, yyyy] = mdy.split("/");
  if (!mm || !dd || !yyyy) return "";
  return new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))).toISOString().slice(0, 10);
}
