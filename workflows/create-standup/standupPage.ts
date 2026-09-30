import { isFullBlock, isFullPage, type Client } from "@notionhq/client";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";
// Utils
import { getAllBlocks } from "utils/notion";
import { logger } from "utils/logger";
// Config
import { SUMMARY_ADDED_PROPERTY } from "./config";

type Block = BlockObjectResponse;
export type ListItemType = "bulleted_list_item" | "numbered_list_item" | "to_do";

export interface RichText {
  type: "text";
  text: { content: string; link?: { url: string } | null };
  annotations?: Record<string, unknown>;
}

// One line in a section: its plain text, its formatting for copying
// elsewhere, and whether it's ticked (to-dos only).
export interface SectionLine {
  block: Block;
  text: string;
  richText: RichText[];
  checked: boolean | null;
}

export interface Section {
  // Lines with something typed in them, in page order.
  lines: SectionLine[];
  // Empty placeholder lines, tidied away once items are added.
  blanks: Block[];
  parentId: string;
  // New items go after this block, or at the start of a toggle heading.
  insertAfterId: string | null;
}

export interface NewItem {
  type: ListItemType;
  richText: RichText[];
  checked?: boolean;
}

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

export interface WaitOptions {
  retries: number;
  delayMs: number;
}

const HEADING_TYPES = new Set(["heading_1", "heading_2", "heading_3"]);
const TEXT_BLOCK_TYPES = new Set<string>(["bulleted_list_item", "numbered_list_item", "to_do", "paragraph"]);
// Blocks whose children are separate pages or databases, not page layout.
const OPAQUE_TYPES = new Set(["child_page", "child_database"]);
const MAX_SEARCH_DEPTH = 3;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ResponseRichText = { plain_text: string; href: string | null; annotations?: Record<string, unknown> };

const responseRichText = (block: Block): ResponseRichText[] => {
  const content = (block as unknown as Record<string, { rich_text?: ResponseRichText[] }>)[block.type];
  return content?.rich_text ?? [];
};

const blockText = (block: Block): string =>
  responseRichText(block).map((t) => t.plain_text).join("");

// Copies a block's text and formatting. Mentions and equations become plain
// text, since they can't be recreated exactly.
const copyRichText = (block: Block): RichText[] =>
  responseRichText(block).map((t) => ({
    type: "text",
    text: { content: t.plain_text, link: t.href ? { url: t.href } : null },
    ...(t.annotations ? { annotations: t.annotations } : {}),
  }));

export const textToRichText = (text: string): RichText[] => [{ type: "text", text: { content: text } }];

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

const buildItem = ({ type, richText, checked }: NewItem) => {
  if (type === "to_do") return { type, to_do: { rich_text: richText, checked: checked ?? false } };
  if (type === "numbered_list_item") return { type, numbered_list_item: { rich_text: richText } };
  return { type, bulleted_list_item: { rich_text: richText } };
};

// ---------------------------------------------------------------------------
// Finding or creating pages
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

// The most recent standup dated on or before isoDate, so a missing day
// (holiday, sick day) falls back to the last standup before it.
export const findLatestPageOnOrBefore = async (
  notion: Client,
  dataSourceId: string,
  isoDate: string
): Promise<PageObjectResponse | undefined> => {
  const response = await notion.dataSources.query({
    data_source_id: dataSourceId,
    filter: { property: "Date", date: { on_or_before: isoDate } },
    sorts: [{ property: "Date", direction: "descending" }],
    page_size: 1,
  });
  return response.results.filter(isFullPage)[0];
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
// The "Summary added" checkbox
// ---------------------------------------------------------------------------

export const isSummaryAdded = (page: PageObjectResponse): boolean => {
  const property = page.properties[SUMMARY_ADDED_PROPERTY];
  if (!property) {
    throw new Error(`The Standups database has no "${SUMMARY_ADDED_PROPERTY}" checkbox property`);
  }
  return property.type === "checkbox" && property.checkbox;
};

export const markSummaryAdded = async (notion: Client, pageId: string): Promise<void> => {
  await notion.pages.update({
    page_id: pageId,
    properties: { [SUMMARY_ADDED_PROPERTY]: { checkbox: true } },
  });
};

// ---------------------------------------------------------------------------
// Reading and adding to sections
// ---------------------------------------------------------------------------

// Depth-first search for the first heading containing headingText, looking
// inside layout blocks such as columns, callouts and toggles.
const findHeading = async (
  notion: Client,
  parentId: string,
  headingText: string,
  depth = 0
): Promise<HeadingLocation | null> => {
  const wanted = headingText.toLowerCase();
  const blocks = await getFullBlocks(notion, parentId);
  const index = blocks.findIndex((b) => isHeading(b) && blockText(b).toLowerCase().includes(wanted));
  if (index !== -1) return { heading: blocks[index], parentId, siblings: blocks, index };

  if (depth >= MAX_SEARCH_DEPTH) return null;
  for (const block of blocks) {
    if (!block.has_children || OPAQUE_TYPES.has(block.type)) continue;
    const found = await findHeading(notion, block.id, headingText, depth + 1);
    if (found) return found;
  }
  return null;
};

// Reads the section under a heading: a plain heading followed by blocks up
// to the next heading, or a toggle heading with the blocks nested inside.
// Returns null if the heading never appears. A new page's template lands
// asynchronously, so `wait` allows for polling.
export const readSection = async (
  notion: Client,
  pageId: string,
  headingText: string,
  { retries, delayMs }: WaitOptions
): Promise<Section | null> => {
  let location: HeadingLocation | null = null;
  for (let attempt = 1; attempt <= retries && !location; attempt++) {
    location = await findHeading(notion, pageId, headingText);
    if (!location && attempt < retries) await sleep(delayMs);
  }
  if (!location) return null;

  const { heading, parentId, siblings, index } = location;
  let blocks: Block[];
  let sectionParentId: string;
  let startAnchor: string | null;
  if (isToggleableHeading(heading)) {
    blocks = heading.has_children ? await getFullBlocks(notion, heading.id) : [];
    sectionParentId = heading.id;
    startAnchor = null;
  } else {
    const rest = siblings.slice(index + 1);
    const nextHeading = rest.findIndex(isHeading);
    blocks = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    sectionParentId = parentId;
    startAnchor = heading.id;
  }

  const filled = blocks.filter((b) => !isBlank(b));
  return {
    lines: filled
      .filter((b) => TEXT_BLOCK_TYPES.has(b.type))
      .map((block) => ({
        block,
        text: blockText(block).trim(),
        richText: copyRichText(block),
        checked: block.type === "to_do" ? block.to_do.checked : null,
      }))
      .filter((line) => line.text !== ""),
    blanks: blocks.filter(isBlank),
    parentId: sectionParentId,
    insertAfterId: filled.length > 0 ? filled[filled.length - 1].id : startAnchor,
  };
};

// Adds items after the last thing already in the section, so anything typed
// by hand stays first, then deletes the section's empty placeholder lines.
export const appendToSection = async (notion: Client, section: Section, items: NewItem[]): Promise<void> => {
  if (items.length === 0) return;
  // The SDK's typed append predates the position parameter, which replaces
  // the deprecated "after" parameter.
  await notion.request({
    path: `blocks/${section.parentId}/children`,
    method: "patch",
    body: {
      children: items.map(buildItem),
      position: section.insertAfterId
        ? { type: "after_block", after_block: { id: section.insertAfterId } }
        : { type: "start" },
    },
  });
  for (const blank of section.blanks) {
    await notion.blocks.delete({ block_id: blank.id });
  }
};
