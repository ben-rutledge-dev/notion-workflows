// Reads the PAT owner's Azure DevOps activity for one day. This module is
// strictly read-only: every request is a GET, apart from the WIQL query,
// which is a POST that only runs a search. The PAT should also be scoped to
// Work Items (Read) so Azure DevOps itself rejects any write.
import { logger } from "utils/logger";
import { addDays, htmlToText, toLocalIsoDate } from "./utils";

export interface StateChange {
  from: string | null;
  to: string;
}

export interface WorkItemActivity {
  id: number;
  title: string;
  type: string;
  state: string;
  stateChanges: StateChange[];
  comments: string[];
}

interface AzureDevOpsConfig {
  org: string;
  project: string;
  pat: string;
}

interface FieldChange {
  oldValue?: unknown;
  newValue?: unknown;
}

interface WorkItemUpdate {
  id: number;
  revisedBy?: { id?: string };
  fields?: Record<string, FieldChange>;
}

interface WorkItem {
  id: number;
  fields: Record<string, unknown>;
}

const API_VERSION = "7.1";
const MAX_IDS_PER_REQUEST = 200;
const UPDATES_PAGE_SIZE = 200;
const WIQL_PATH = "/_apis/wit/wiql";

export const createAzureDevOpsClient = ({ org, project, pat }: AzureDevOpsConfig) => {
  const authorization = `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;

  const request = async <T>(path: string, body?: unknown): Promise<T> => {
    const method = body === undefined ? "GET" : "POST";
    if (method === "POST" && !path.includes(WIQL_PATH)) {
      throw new Error(`Refusing to send a POST to ${path}: only WIQL queries may use POST`);
    }

    const res = await fetch(`https://dev.azure.com/${encodeURIComponent(org)}${path}`, {
      method,
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });

    // An invalid or expired PAT often gets a 203 or a redirect to a sign-in
    // page instead of a 401, so anything other than a 200 is a failure.
    if (res.status !== 200) {
      const likelyAuth = res.status === 203 || res.status === 401 || (res.status >= 300 && res.status < 400);
      const hint = likelyAuth ? " (the PAT is probably invalid, expired or missing the Work Items: Read scope)" : "";
      const detail = (await res.text()).slice(0, 300);
      throw new Error(`Azure DevOps ${method} ${path} returned ${res.status}${hint}: ${detail}`);
    }
    return (await res.json()) as T;
  };

  const getMyId = async (): Promise<string> => {
    const data = await request<{ authenticatedUser?: { id?: string } }>("/_apis/connectionData");
    const id = data.authenticatedUser?.id;
    if (!id) throw new Error("Azure DevOps connectionData did not return the PAT owner's ID");
    return id;
  };

  // Items changed since the day before (slack for Azure DevOps' own timezone
  // handling) that I have changed at some point. The exact per-update
  // filtering happens afterwards.
  const getCandidateIds = async (activityDate: string): Promise<number[]> => {
    const since = addDays(activityDate, -1);
    const query =
      "SELECT [System.Id] FROM WorkItems " +
      "WHERE [System.TeamProject] = @project " +
      `AND [System.ChangedDate] >= '${since}' ` +
      "AND EVER [System.ChangedBy] = @Me";
    const data = await request<{ workItems?: Array<{ id: number }> }>(
      `/${encodeURIComponent(project)}${WIQL_PATH}?api-version=${API_VERSION}`,
      { query }
    );
    return (data.workItems ?? []).map((w) => w.id);
  };

  const getWorkItems = async (ids: number[]): Promise<Map<number, WorkItem>> => {
    const items = new Map<number, WorkItem>();
    for (let i = 0; i < ids.length; i += MAX_IDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + MAX_IDS_PER_REQUEST);
      const data = await request<{ value: Array<WorkItem | null> }>(
        `/_apis/wit/workitems?ids=${chunk.join(",")}` +
          "&fields=System.Title,System.WorkItemType,System.State" +
          `&errorPolicy=omit&api-version=${API_VERSION}`
      );
      for (const item of data.value) if (item) items.set(item.id, item);
    }
    return items;
  };

  const getUpdates = async (id: number): Promise<WorkItemUpdate[]> => {
    const updates: WorkItemUpdate[] = [];
    for (let skip = 0; ; skip += UPDATES_PAGE_SIZE) {
      const data = await request<{ value?: WorkItemUpdate[] }>(
        `/_apis/wit/workItems/${id}/updates?$top=${UPDATES_PAGE_SIZE}&$skip=${skip}&api-version=${API_VERSION}`
      );
      const page = data.value ?? [];
      updates.push(...page);
      if (page.length < UPDATES_PAGE_SIZE) return updates;
    }
  };

  // Work items where I changed the state or commented on activityDate.
  // Items with no such activity are left out.
  const getActivity = async (activityDate: string): Promise<WorkItemActivity[]> => {
    const myId = await getMyId();
    const ids = await getCandidateIds(activityDate);
    logger.info(`Azure DevOps returned ${ids.length} candidate work item(s)`);
    const items = await getWorkItems(ids);

    const activity: WorkItemActivity[] = [];
    let skipped = 0;
    for (const id of ids) {
      const item = items.get(id);
      if (!item) continue;

      // An update's own revisedDate is when it was superseded, not when it
      // happened, so the change time comes from System.ChangedDate.
      const mine = (await getUpdates(id)).filter((u) => {
        const changedAt = u.fields?.["System.ChangedDate"]?.newValue;
        return (
          u.revisedBy?.id === myId &&
          typeof changedAt === "string" &&
          toLocalIsoDate(new Date(changedAt)) === activityDate
        );
      });

      const stateChanges: StateChange[] = [];
      const comments: string[] = [];
      for (const u of mine) {
        const state = u.fields?.["System.State"];
        if (typeof state?.newValue === "string") {
          stateChanges.push({
            from: typeof state.oldValue === "string" ? state.oldValue : null,
            to: state.newValue,
          });
        }
        const history = u.fields?.["System.History"]?.newValue;
        if (typeof history === "string") {
          const text = htmlToText(history);
          if (text) comments.push(text);
        }
      }

      if (stateChanges.length === 0 && comments.length === 0) {
        skipped++;
        continue;
      }
      activity.push({
        id,
        title: String(item.fields["System.Title"] ?? ""),
        type: String(item.fields["System.WorkItemType"] ?? ""),
        state: String(item.fields["System.State"] ?? ""),
        stateChanges,
        comments,
      });
    }

    logger.info(
      `${activity.length} work item(s) had state changes or comments by you on ${activityDate}, ${skipped} had none`
    );
    return activity;
  };

  return { getActivity };
};
