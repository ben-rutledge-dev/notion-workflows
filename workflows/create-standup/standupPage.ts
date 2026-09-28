import { isFullBlock, isFullPage, type Client } from "@notionhq/client";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
// Utils
import { getAllBlocks } from "utils/notion";
import { logger } from "utils/logger";

type Block = BlockObjectResponse;
type ListItemType = "bulleted_list_item" | "numbered_list_item" | "to_do";

interface Template {
  id: string;
  name: string;
  is_default: boolean;
}

interface HeadingLocation {
  heading: Block;
  parentId: string;
  siblings: Block[];
  index: number;
}

interface WaitOptions {
  retries: number;
  delayMs: number;
}

export type FillResult = "filled" | "not-empty";

const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3"]);
const LIST_ITEM_TYPES = new Set<string>(["bulleted_list_item", "numbered_list_item", "to_do"]);
const TEXT_BLOCK_TYPES = new Set<string>([...LIST_ITEM_TYPES, "paragraph"]);
// Blocks whose children are separate pages or databases, not page layout.
const OPAQUE_TYPES = new Set(["child_page", "child_database"]);
const MAX_SEARCH_DEPTH = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const blockText = (block: Block): string => {
  const content = (block as unknown as Record<string, { rich_text?: Array<{ plain_text: string }> }>)[block.type];
  return (content?.rich_text ?? []).map((t) => t.plain_text).join("");
};

const isHeading = (block: Block): boolean => HEADING_TYPES.has(block.type);

const isToggleableHeading = (block: Block): boolean =>
  (block.type === "heading_1" && block.heading_1.is_toggleable) ||
  (block.type === "heading_2" && block.heading_2.is_toggleable) ||
  (block.type === "heading_3" && block.heading_3.is_toggleable);

// A block that holds nothing typed by hand: an empty bullet, to-do,
// numbered item or paragraph.
const isBlank = (block: Block): boolean =>
  TEXT_BLOCK_TYPES.has(block.type) && !block.has_children && blockText(block).trim() === "";

const getFullBlocks = async (notion: Client, parentId: string): Promise<Block[]> =>
  (await getAllBlocks(notion, parentId)).filter(isFullBlock);

const buildItem = (type: ListItemType, text: string) => {
  const rich_text = [{ type: "text" as const, text: { content: text } }];
  if (type === "to_do") return { type, to_do: { rich_text, checked: false } };
  if (type === "numbered_list_item") return { type, numbered_list_item: { rich_text } };
  return { type, bulleted_list_item: { rich_text } };
};

// ---------------------------------------------------------------------------
// Finding or creating the page
// ---------------------------------------------------------------------------

// Newer Notion API calls address a database's data source rather than the
// database itself, so resolve it from the database ID.
export const getDataSourceId = async (notion: Client, databaseId: string): Promise<string> => {
  const database = await notion.databases.retrieve({ database_id: databaseId });
  const dataSources = "data_sources" in database ? database.data_sources : [];
  if (dataSources.length === 0) {
    throw new Error(`Database ${databaseId} has no data sources the integration can see`);
  }
  if (dataSources.length > 1) {
    logger.alert(`Database has ${dataSources.length} data sources, using the first: "${dataSources[0].name}"`);
  }
  return dataSources[0].id;
};

export const findPagesByDate = async (
  notion: Client,
  dataSourceId: string,
  isoDate: string
): Promise<PageObjectResponse[]> => {
  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: "Date", date: { equals: isoDate } },
    page_size: 10,
  });
  return response.results.filter(isFullPage);
};

// Uses the data source's default template, or its only template if none is
// marked as the default.
const getTemplateId = async (notion: Client, dataSourceId: string): Promise<string> => {
  const { templates } = await notion.request<{ templates: Template[] }>({
    path: `data_sources/${dataSourceId}/templates`,
    method: "get",
  });
  const chosen = templates.find((t) => t.is_default) ?? (templates.length === 1 ? templates[0] : undefined);
  if (!chosen) {
    const names = templates.map((t) => `"${t.name}"`).join(", ") || "none";
    throw new Error(
      `Can't pick a template for new standup pages. Mark one as the default in Notion. Templates found: ${names}`
    );
  }
  logger.info(`Using template "${chosen.name}"`);
  return chosen.id;
};

const createPage = async (
  notion: Client,
  dataSourceId: string,
  title: string,
  isoDate: string
): Promise<PageObjectResponse> => {
  const templateId = await getTemplateId(notion, dataSourceId);
  // The installed SDK's typed pages.create predates the template parameter,
  // so this goes through the SDK's generic request method.
  return notion.request<PageObjectResponse>({
    path: "pages",
    method: "post",
    body: {
      parent: { type: "data_source_id", data_source_id: dataSourceId },
      properties: {
        Name: { title: [{ text: { content: title } }] },
        Date: { date: { start: isoDate } },
      },
      template: { type: "template_id", template_id: templateId },
    },
  });
};

// Reuses the page for isoDate if one exists (re-runs, retries, a page made
// by hand), otherwise creates it from the template.
export const findOrCreateStandupPage = async (
  notion: Client,
  dataSourceId: string,
  title: string,
  isoDate: string
): Promise<{ page: PageObjectResponse; created: boolean }> => {
  const existing = await findPagesByDate(notion, dataSourceId, isoDate);
  if (existing.length > 0) {
    if (existing.length > 1) {
      logger.alert(`Found ${existing.length} pages dated ${isoDate}, using the first: ${existing[0].url}`);
    }
    return { page: existing[0], created: false };
  }
  return { page: await createPage(notion, dataSourceId, title, isoDate), created: true };
};

// ---------------------------------------------------------------------------
// Filling the section
// ---------------------------------------------------------------------------

// Depth-first search for the first heading containing headingText, looking
// inside layout blocks such as columns, callouts and toggles.
const findHeading = async (
  notion: Client,
  parentId: string,
  headingText: string,
  depth = 0
): Promise<HeadingLocation | null> => {
  const blocks = await getFullBlocks(notion, parentId);
  const index = blocks.findIndex((b) => isHeading(b) && blockText(b).includes(headingText));
  if (index !== -1) return { heading: blocks[index], parentId, siblings: blocks, index };

  if (depth >= MAX_SEARCH_DEPTH) return null;
  for (const block of blocks) {
    if (!block.has_children || OPAQUE_TYPES.has(block.type)) continue;
    const found = await findHeading(notion, block.id, headingText, depth + 1);
    if (found) return found;
  }
  return null;
};

const waitForHeading = async (
  notion: Client,
  pageId: string,
  headingText: string,
  { retries, delayMs }: WaitOptions
): Promise<HeadingLocation> => {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const found = await findHeading(notion, pageId, headingText);
    if (found) return found;
    if (attempt < retries) await sleep(delayMs);
  }
  throw new Error(`Heading containing "${headingText}" not found on the page`);
};

const appendItems = async (
  notion: Client,
  parentId: string,
  afterBlockId: string | null,
  type: ListItemType,
  texts: string[]
): Promise<void> => {
  if (texts.length === 0) return;
  // The SDK's typed append predates the position parameter, which replaces
  // the deprecated "after" parameter.
  await notion.request({
    path: `blocks/${parentId}/children`,
    method: "patch",
    body: {
      children: texts.map((text) => buildItem(type, text)),
      position: afterBlockId
        ? { type: "after_block", after_block: { id: afterBlockId } }
        : { type: "start" },
    },
  });
};

// Writes bullets under the heading, but only if that section holds nothing
// but empty placeholders. Works with a plain heading followed by blocks, or
// a toggle heading with the blocks nested inside it. New items copy the
// placeholder's block type, so a to-do placeholder gets to-do items.
export const fillSectionIfEmpty = async (
  notion: Client,
  pageId: string,
  headingText: string,
  bullets: string[],
  wait: WaitOptions
): Promise<FillResult> => {
  const { heading, parentId, siblings, index } = await waitForHeading(notion, pageId, headingText, wait);

  let section: Block[];
  let insertParentId: string;
  let insertAfterId: string | null;
  if (isToggleableHeading(heading)) {
    section = heading.has_children ? await getFullBlocks(notion, heading.id) : [];
    insertParentId = heading.id;
    insertAfterId = null;
  } else {
    const rest = siblings.slice(index + 1);
    const nextHeading = rest.findIndex(isHeading);
    section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    insertParentId = parentId;
    insertAfterId = heading.id;
  }

  if (!section.every(isBlank)) return "not-empty";

  const placeholder = section[0];
  if (placeholder && LIST_ITEM_TYPES.has(placeholder.type)) {
    const type = placeholder.type as ListItemType;
    const [first, ...rest] = bullets;
    const updated = buildItem(type, first);
    await notion.blocks.update({ block_id: placeholder.id, ...updated } as Parameters<Client["blocks"]["update"]>[0]);
    await appendItems(notion, insertParentId, placeholder.id, type, rest);
  } else {
    await appendItems(notion, insertParentId, insertAfterId, "bulleted_list_item", bullets);
  }
  return "filled";
};
