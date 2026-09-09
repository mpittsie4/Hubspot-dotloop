import { HubSpotDealProperties } from "../clients/hubspotClient";
import { DotloopLoopDetail, DotloopLoopSummary } from "../clients/dotloopClient";

/**
 * Dotloop loop status is scoped to a transactionType (see dotloop's docs):
 *   PURCHASE_OFFER:    PRE_OFFER | UNDER_CONTRACT | SOLD | ARCHIVED
 *   LISTING_FOR_SALE:  PRE_LISTING | PRIVATE_LISTING | ACTIVE_LISTING | UNDER_CONTRACT | SOLD | ARCHIVED
 *   LISTING_FOR_LEASE: PRE_LISTING | PRIVATE_LISTING | ACTIVE_LISTING | UNDER_CONTRACT | LEASED | ARCHIVED
 *   LEASE_OFFER:       PRE_OFFER | UNDER_CONTRACT | LEASED | ARCHIVED
 *   OTHER/REAL_ESTATE_OTHER: NEW | IN_PROGRESS | DONE | ARCHIVED
 *
 * HubSpot deal stages are custom per-portal internal ids (not the label you
 * see in the UI), so there is no universal mapping — you MUST fill in
 * STAGE_TO_STATUS / STATUS_TO_STAGE below with your portal's actual
 * dealstage internal IDs (Settings -> Objects -> Deals -> Pipelines) and
 * the loop transaction type you intend to sync (default assumed:
 * PURCHASE_OFFER, i.e. a buy-side pipeline). This is the one piece of this
 * connector that's inherently org-specific.
 */
export const DEFAULT_TRANSACTION_TYPE = "PURCHASE_OFFER";

export const STAGE_TO_STATUS: Record<string, string> = {
  // "appointmentscheduled": "PRE_OFFER",
  // "contractsent": "PRE_OFFER",
  // "decisionmakerboughtin": "UNDER_CONTRACT",
  // "closedwon": "SOLD",
  // "closedlost": "ARCHIVED",
};

export const STATUS_TO_STAGE: Record<string, string> = Object.fromEntries(
  Object.entries(STAGE_TO_STATUS).map(([stage, status]) => [status, stage])
);

export interface CanonicalDeal {
  name: string;
  status: string; // dotloop loop status vocabulary
  purchasePrice: string; // numeric string, no currency symbol
  closingDate: string; // MM/DD/YYYY (dotloop's expected format)
}

export function fromHubSpotDeal(props: HubSpotDealProperties): CanonicalDeal {
  return {
    name: props.dealname ?? "",
    status: (props.dealstage && STAGE_TO_STATUS[props.dealstage]) || "PRE_OFFER",
    purchasePrice: props.amount ?? "",
    closingDate: props.closedate ? isoToMDY(props.closedate) : "",
  };
}

export function toHubSpotDealProperties(c: CanonicalDeal): HubSpotDealProperties {
  return {
    dealname: c.name,
    dealstage: STATUS_TO_STAGE[c.status] ?? undefined,
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
  return { name: c.name, status: c.status };
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
