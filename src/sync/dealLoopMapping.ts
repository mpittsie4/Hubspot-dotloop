import { HubSpotDealProperties } from "../clients/hubspotClient";
import { DotloopLoopDetail, DotloopLoopSummary } from "../clients/dotloopClient";
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
 *
 * HubSpot deal stages are custom per-portal internal ids (not the label you
 * see in the UI) and are scoped to a specific pipeline. This portal has
 * three deal pipelines (Renter / Buyer / Seller), each corresponding to a
 * different Dotloop transactionType, so the stage<->status mapping has to
 * be pipeline-aware in both directions:
 *
 *  - HubSpot -> Dotloop (a specific dealstage always implies exactly one
 *    status) is unambiguous — see STAGE_TO_STATUS below.
 *  - Dotloop -> HubSpot (a status alone doesn't say which pipeline, or
 *    which stage within that pipeline, since several stages in the same
 *    pipeline can share one status — e.g. Buyer's "Engaging", "Qualified"
 *    and "Preview Properties" are ALL "Pre-Offer") needs the deal's
 *    pipeline as extra context, plus a documented tie-break for the
 *    still-ambiguous same-pipeline case. See resolveStageForStatus below
 *    and how dealLoopSync.ts supplies that pipeline context.
 *
 * If you add a pipeline or reconnect this app to a different portal, update
 * PIPELINES below with that portal's real pipeline internal ID (Settings ->
 * Objects -> Deals -> Pipelines) and dealstage internal IDs, and confirm
 * the transactionType correspondence with whoever owns the Dotloop account
 * — pipeline naming alone is a reasonable guess but not a guarantee.
 */

export type DotloopTransactionType =
  | "PURCHASE_OFFER"
  | "LISTING_FOR_SALE"
  | "LISTING_FOR_LEASE"
  | "LEASE_OFFER"
  | "REAL_ESTATE_OTHER";

export const DEFAULT_TRANSACTION_TYPE: DotloopTransactionType = "PURCHASE_OFFER";

export interface PipelineStage {
  id: string; // HubSpot dealstage internal ID
  label: string; // HubSpot stage label, for readability only
  status: string; // Dotloop status this stage maps to
}

export interface PipelineConfig {
  key: string;
  pipelineId: string; // HubSpot pipeline internal ID
  transactionType: DotloopTransactionType;
  /** In HubSpot's funnel order — resolveStageForStatus relies on this order. */
  stages: PipelineStage[];
}

export const PIPELINES: PipelineConfig[] = [
  {
    key: "renter",
    pipelineId: "t_eb9a14cb632386c0af1109197b394aeb",
    transactionType: "LEASE_OFFER",
    stages: [
      { id: "3232443112", label: "New Lead", status: "Pre-Offer" },
      { id: "3232443113", label: "Viewing", status: "Pre-Offer" },
      { id: "3232443114", label: "Security Deposit Paid", status: "Under Contract" },
      { id: "3232443115", label: "Closed Won", status: "Leased" },
      { id: "3232443116", label: "Closed Lost", status: "Terminated" },
    ],
  },
  {
    key: "buyer",
    pipelineId: "t_8253aef829fecc1d752892a47a66112a",
    transactionType: "PURCHASE_OFFER",
    stages: [
      { id: "3232431837", label: "Engaging", status: "Pre-Offer" },
      { id: "3232431838", label: "Qualified", status: "Pre-Offer" },
      { id: "3232431839", label: "Preview Properties", status: "Pre-Offer" },
      { id: "3232431840", label: "Offer to Purchase", status: "Pre-Offer" },
      { id: "3232431841", label: "Negotiations", status: "Pre-Offer" },
      { id: "3232431842", label: "Accepted Offer", status: "Under Contract" },
      { id: "3251013337", label: "Active Closing", status: "Under Contract" },
      { id: "3251013338", label: "Closing Sceduled", status: "Under Contract" },
      { id: "3232431843", label: "Closed Won", status: "Sold" },
      { id: "3232431844", label: "Closed Lost", status: "Terminated" },
    ],
  },
  {
    key: "seller",
    pipelineId: "t_a5d44b5aaea04682e5441ad22e52f824",
    transactionType: "LISTING_FOR_SALE",
    stages: [
      { id: "3232320228", label: "Engaging", status: "Pre-Listing" },
      { id: "3232320229", label: "Qualified", status: "Pre-Listing" },
      { id: "3232320230", label: "Listing Agreement Signed", status: "Pre-Listing" },
      { id: "3232320231", label: "Listed in MLS", status: "Active Listing" },
      { id: "3232320232", label: "Offer Made", status: "Active Listing" },
      { id: "3232320233", label: "Offer Accepted", status: "Under Contract" },
      { id: "3232320234", label: "Active Closing", status: "Under Contract" },
      { id: "3232320235", label: "Closing Scheduled", status: "Under Contract" },
      { id: "3232320236", label: "Closed Won", status: "Sold" },
      { id: "3232320237", label: "Closed Lost", status: "Terminated" },
    ],
  },
];

/** Flat dealstageId -> status, derived from PIPELINES. Unambiguous: a given
 * dealstage id belongs to exactly one pipeline and always implies the same
 * status, so this direction needs no extra context. */
export const STAGE_TO_STATUS: Record<string, string> = Object.fromEntries(
  PIPELINES.flatMap((p) => p.stages.map((s) => [s.id, s.status]))
);

export function getPipelineForStageId(stageId: string): PipelineConfig | undefined {
  return PIPELINES.find((p) => p.stages.some((s) => s.id === stageId));
}

export function getPipelineById(pipelineId: string | undefined): PipelineConfig | undefined {
  if (!pipelineId) return undefined;
  return PIPELINES.find((p) => p.pipelineId === pipelineId);
}

export function getPipelineForTransactionType(transactionType: string | undefined): PipelineConfig | undefined {
  if (!transactionType) return undefined;
  return PIPELINES.find((p) => p.transactionType === transactionType);
}

/**
 * Resolves which HubSpot stage a deal should move to for a given Dotloop
 * status, within a specific (already-known) pipeline.
 *
 * Because Dotloop's status vocabulary is coarser than HubSpot's stage
 * vocabulary, several stages in the same pipeline can share one status
 * (e.g. Buyer's "Engaging", "Qualified", and "Preview Properties" are all
 * "Pre-Offer") — that many-to-one mapping is inherent to how this portal's
 * funnel was designed, not something more data can fully undo. This is
 * therefore a best-effort resolution, not a perfect inverse of
 * STAGE_TO_STATUS, and applies a documented tie-break:
 *
 *   1. If the deal's current stage already maps to the target status,
 *      keep it. This avoids yanking a deal backward to some earlier
 *      same-status stage on every sync cycle just because Dotloop's
 *      status hasn't changed.
 *   2. Otherwise, prefer the LAST candidate stage in the pipeline's
 *      funnel order (PIPELINES stage order == HubSpot's own stage order)
 *      — i.e. the furthest-along stage carrying that status — since a
 *      Dotloop status change normally reflects forward progress.
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

export interface CanonicalDeal {
  name: string;
  status: string; // dotloop loop status vocabulary; "" if unresolved
  purchasePrice: string; // numeric string, no currency symbol
  closingDate: string; // MM/DD/YYYY (dotloop's expected format)
}

export function fromHubSpotDeal(props: HubSpotDealProperties): CanonicalDeal {
  const status = (props.dealstage && STAGE_TO_STATUS[props.dealstage]) || "";
  if (props.dealstage && !status) {
    logger.warn({ dealstage: props.dealstage }, "Deal stage has no entry in STAGE_TO_STATUS; leaving status unset");
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
  c: CanonicalDeal,
  context: { pipelineId?: string; currentStageId?: string } = {}
): HubSpotDealProperties {
  const pipeline = getPipelineById(context.pipelineId);
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
