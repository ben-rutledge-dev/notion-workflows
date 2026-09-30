import 'dotenv/config';
// Utils
import {
  createNotionClient,
  getAllBlocks,
  getAllPages,
} from "utils/notion";
import { logger } from "utils/logger";
import { createAIClient, type AIClient } from "utils/ai";
// Types
import type {
  PageObjectResponse,
  BlockObjectResponse,
} from "@notionhq/client/build/src/api-endpoints";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const MEAL_PLANNER_DATABASE_ID = process.env.MEAL_PLANNER_DATABASE_ID;
const MEALS_DATABASE_ID = process.env.MEALS_DATABASE_ID;
const SHOPPING_HELPER_DATABASE_ID = process.env.SHOPPING_HELPER_DATABASE_ID;
const GROCERY_SHOPPING_LIST_PAGE_ID = process.env.GROCERY_SHOPPING_LIST_PAGE_ID;
const TURKISH_SUPERMARKET_LIST_PAGE_ID = process.env.TURKISH_SUPERMARKET_LIST_PAGE_ID;
const ASIAN_SUPERMARKET_LIST_PAGE_ID = process.env.ASIAN_SUPERMARKET_LIST_PAGE_ID;

if (!NOTION_TOKEN) {
  logger.error("NOTION_TOKEN is not defined");
  process.exit(1);
}

if (!MEAL_PLANNER_DATABASE_ID) {
  logger.error("MEAL_PLANNER_DATABASE_ID is not defined");
  process.exit(1);
}

if (!MEALS_DATABASE_ID) {
  logger.error("MEALS_DATABASE_ID is not defined");
  process.exit(1);
}

if (!SHOPPING_HELPER_DATABASE_ID) {
  logger.error("SHOPPING_HELPER_DATABASE_ID is not defined");
  process.exit(1);
}

if (!GROCERY_SHOPPING_LIST_PAGE_ID) {
  logger.error("GROCERY_SHOPPING_LIST_PAGE_ID is not defined");
  process.exit(1);
}

if (!TURKISH_SUPERMARKET_LIST_PAGE_ID) {
  logger.error("TURKISH_SUPERMARKET_LIST_PAGE_ID is not defined");
  process.exit(1);
}

if (!ASIAN_SUPERMARKET_LIST_PAGE_ID) {
  logger.error("ASIAN_SUPERMARKET_LIST_PAGE_ID is not defined");
  process.exit(1);
}

const notion = createNotionClient(NOTION_TOKEN);
const ai: AIClient = await createAIClient();

interface Meal {
  id: string;
  name: string;
  date: string;
  ingredients: string[];
}

interface HelperItem {
  id: string;
  item: string;
  addToShoppingList: boolean;
  addToTurkishList: boolean;
  addToAsianList: boolean;
  delete: boolean;
  processingStatus: "New" | "Processed" | "Staple";
  inventoryStatus?: "In Stock" | "Low stock" | "Out of stock";
  mealId?: string;
  createdTime: string;
  lastProcessed?: string;
}

type ShoppingListType = 'grocery' | 'turkish' | 'asian';

// Get meals for the next 7 days by querying the meal planner and following relations
const getUpcomingMeals = async (): Promise<Meal[]> => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const sevenDaysFromNow = new Date(today);
  sevenDaysFromNow.setDate(today.getDate() + 7);

  // Query the Meal Planner database for the next 7 days
  const response = await fetch(
    `https://api.notion.com/v1/databases/${MEAL_PLANNER_DATABASE_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: "Date",
              date: {
                on_or_after: today.toISOString().split('T')[0],
              },
            },
            {
              property: "Date",
              date: {
                before: sevenDaysFromNow.toISOString().split('T')[0],
              },
            },
          ],
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to query meal planner database: ${error.message}`);
  }

  const data = await response.json();
  const plannerPages = data.results.filter(
    (page: unknown): page is PageObjectResponse => {
      return typeof page === "object" && page !== null && "properties" in page;
    }
  );

  // Collect all meal IDs from Breakfast, Lunch, and Dinner relations
  const mealIds = new Set<string>();
  const mealIdToDate = new Map<string, string>();

  for (const page of plannerPages) {
    const dateProperty = page.properties.Date;
    const date = dateProperty?.type === "date" ? dateProperty.date?.start || "" : "";

    const breakfastProp = page.properties.Breakfast;
    const lunchProp = page.properties.Lunch;
    const dinnerProp = page.properties.Dinner;

    if (breakfastProp?.type === "relation") {
      for (const rel of breakfastProp.relation) {
        mealIds.add(rel.id);
        mealIdToDate.set(rel.id, date);
      }
    }

    if (lunchProp?.type === "relation") {
      for (const rel of lunchProp.relation) {
        mealIds.add(rel.id);
        mealIdToDate.set(rel.id, date);
      }
    }

    if (dinnerProp?.type === "relation") {
      for (const rel of dinnerProp.relation) {
        mealIds.add(rel.id);
        mealIdToDate.set(rel.id, date);
      }
    }
  }

  if (mealIds.size === 0) {
    logger.info("No meals found in the next 7 days");
    return [];
  }

  // Fetch all the actual meal pages from the Meals database
  const meals: Meal[] = [];

  for (const mealId of mealIds) {
    try {
      const mealPage = await notion.pages.retrieve({ page_id: mealId });

      if (!("properties" in mealPage)) {
        continue;
      }

      const nameProperty = mealPage.properties.Name;
      const ingredientsProperty = mealPage.properties.Ingredients;

      const name = nameProperty?.type === "title"
        ? nameProperty.title[0]?.plain_text || ""
        : "";

      const ingredients = ingredientsProperty?.type === "multi_select"
        ? ingredientsProperty.multi_select.map((i) => i.name)
        : [];

      const date = mealIdToDate.get(mealId) || "";

      if (name && ingredients.length > 0) {
        meals.push({ id: mealId, name, date, ingredients });
      }
    } catch (error) {
      logger.warn("Failed to fetch meal", { mealId, error });
    }
  }

  return meals;
};

// Get existing helper items (including all statuses, no archiving)
const getHelperItems = async (): Promise<HelperItem[]> => {
  const allPages: PageObjectResponse[] = [];
  let hasMore = true;
  let startCursor: string | undefined = undefined;

  // Paginate through all results
  while (hasMore) {
    const response = await fetch(
      `https://api.notion.com/v1/databases/${SHOPPING_HELPER_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          start_cursor: startCursor,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`Failed to query helper database: ${error.message}`);
    }

    const data = await response.json();
    const pages = data.results.filter(
      (page): page is PageObjectResponse => "properties" in page
    );
    allPages.push(...pages);

    hasMore = data.has_more;
    startCursor = data.next_cursor;
  }

  return allPages
    .map((page) => {
      const itemProperty = page.properties.Item;
      const groceryCheckboxProperty = page.properties["Add to shopping list"];
      const turkishCheckboxProperty = page.properties["Add to Turkish supermarket shopping list"];
      const asianCheckboxProperty = page.properties["Add to Asian supermarket shopping list"];
      const deleteProperty = page.properties.Delete;
      const processingStatusProperty = page.properties["Processing status"];
      const inventoryStatusProperty = page.properties["Inventory status"];
      const mealProperty = page.properties.Meal;
      const lastProcessedProperty = page.properties["Last processed"];

      const item = itemProperty?.type === "title"
        ? itemProperty.title[0]?.plain_text || ""
        : "";

      const addToShoppingList = groceryCheckboxProperty?.type === "checkbox"
        ? groceryCheckboxProperty.checkbox
        : false;

      const addToTurkishList = turkishCheckboxProperty?.type === "checkbox"
        ? turkishCheckboxProperty.checkbox
        : false;

      const addToAsianList = asianCheckboxProperty?.type === "checkbox"
        ? asianCheckboxProperty.checkbox
        : false;

      const deleteFlag = deleteProperty?.type === "checkbox"
        ? deleteProperty.checkbox
        : false;

      const processingStatus = processingStatusProperty?.type === "status"
        ? (processingStatusProperty.status?.name as "New" | "Processed" | "Staple" || "New")
        : "New";

      const inventoryStatus = inventoryStatusProperty?.type === "status"
        ? (inventoryStatusProperty.status?.name as "In Stock" | "Low stock" | "Out of stock" | undefined)
        : undefined;

      const mealId = mealProperty?.type === "relation"
        ? mealProperty.relation[0]?.id
        : undefined;

      const lastProcessed = lastProcessedProperty?.type === "date"
        ? lastProcessedProperty.date?.start
        : undefined;

      const createdTime = page.created_time;

      return {
        id: page.id,
        item,
        addToShoppingList,
        addToTurkishList,
        addToAsianList,
        delete: deleteFlag,
        processingStatus,
        inventoryStatus,
        mealId,
        createdTime,
        lastProcessed
      };
    });
};

// Populate helper database with upcoming meal ingredients using status-based logic
const populateHelperDatabase = async (
  meals: Meal[],
  existingItems: HelperItem[]
): Promise<void> => {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Build a map of existing ingredients by normalized name for quick lookup
  // Also detect duplicates
  const existingItemsMap = new Map<string, HelperItem>();
  const duplicates: string[] = [];

  for (const item of existingItems) {
    const normalized = item.item.toLowerCase();
    if (existingItemsMap.has(normalized)) {
      duplicates.push(item.item);
    }
    existingItemsMap.set(normalized, item);
  }

  if (duplicates.length > 0) {
    logger.warn(`Found ${duplicates.length} duplicate ingredients in database`, {
      duplicates: duplicates.slice(0, 10) // Show first 10
    });
  }

  // Process each ingredient from upcoming meals
  const ingredientsToAdd: Array<{ meal: Meal; ingredient: string }> = [];
  const ingredientsToUpdate: Array<{ item: HelperItem; meal: Meal }> = [];
  const ingredientsProcessed = new Set<string>();

  for (const meal of meals) {
    for (const ingredient of meal.ingredients) {
      const normalizedIngredient = ingredient.toLowerCase();

      // Skip if we've already processed this ingredient in this batch
      if (ingredientsProcessed.has(normalizedIngredient)) {
        continue;
      }
      ingredientsProcessed.add(normalizedIngredient);

      const existingItem = existingItemsMap.get(normalizedIngredient);

      if (!existingItem) {
        // New ingredient - add it
        ingredientsToAdd.push({ meal, ingredient });
      } else if (existingItem.processingStatus === "Staple") {
        // Staples remain as-is, never update them
        // User manages inventory status manually
        logger.info("Skipping staple ingredient", { ingredient });
      } else if (existingItem.processingStatus === "Processed") {
        // Check if it should be reset to New based on last processed date.
        // No date means it was never processed by hand (for example, it
        // expired unused), so it's due for a reset.
        const lastProcessedDate = existingItem.lastProcessed
          ? new Date(existingItem.lastProcessed)
          : null;

        const isOlderThan7Days = !lastProcessedDate || lastProcessedDate < sevenDaysAgo;

        if (isOlderThan7Days) {
          // Reset to New and update meal relation
          await notion.pages.update({
            page_id: existingItem.id,
            properties: {
              "Processing status": {
                status: { name: "New" },
              },
              Meal: {
                relation: [{ id: meal.id }],
              },
            },
          });
          logger.info("Reset processed ingredient to New (>7 days old)", {
            ingredient,
            meal: meal.name,
            lastProcessed: lastProcessedDate?.toISOString() ?? "never"
          });
        } else {
          // Keep as Processed, just update meal relation
          await notion.pages.update({
            page_id: existingItem.id,
            properties: {
              Meal: {
                relation: [{ id: meal.id }],
              },
            },
          });
          logger.info("Kept ingredient as Processed (within 7 days)", {
            ingredient,
            meal: meal.name
          });
        }
      } else {
        // Processing status is New - just update the meal relation to latest meal
        ingredientsToUpdate.push({ item: existingItem, meal });
      }
    }
  }

  // Update meal relations for existing New items
  for (const { item, meal } of ingredientsToUpdate) {
    await notion.pages.update({
      page_id: item.id,
      properties: {
        Meal: {
          relation: [{ id: meal.id }],
        },
      },
    });
    logger.info("Updated meal relation for existing ingredient", {
      ingredient: item.item,
      meal: meal.name
    });
  }

  // Add new ingredients
  for (const { meal, ingredient } of ingredientsToAdd) {
    await notion.pages.create({
      parent: { database_id: SHOPPING_HELPER_DATABASE_ID },
      icon: {
        type: "emoji",
        emoji: "🥫",
      },
      properties: {
        Item: {
          title: [{ text: { content: ingredient } }],
        },
        "Add to shopping list": {
          checkbox: false,
        },
        "Add to Turkish supermarket shopping list": {
          checkbox: false,
        },
        "Add to Asian supermarket shopping list": {
          checkbox: false,
        },
        Delete: {
          checkbox: false,
        },
        "Processing status": {
          status: { name: "New" },
        },
        Meal: {
          relation: [{ id: meal.id }],
        },
      },
    });
    logger.info("Added new ingredient", { ingredient, meal: meal.name });
  }

  if (ingredientsToAdd.length > 0) {
    logger.success("Added new ingredients", { count: ingredientsToAdd.length });
  }
  if (ingredientsToUpdate.length > 0) {
    logger.success("Updated existing ingredients", { count: ingredientsToUpdate.length });
  }
};

// Get existing shopping list headings (now toggle blocks)
const getShoppingListHeadings = async (pageId: string): Promise<string[]> => {
  const blocks = await getAllBlocks(notion, pageId);
  const headings: string[] = [];

  for (const block of blocks) {
    if ("type" in block && block.type === "toggle" && "toggle" in block) {
      const toggle = (block as BlockObjectResponse & { type: "toggle" }).toggle;
      const toggleText = toggle.rich_text?.[0];
      if (toggleText && "plain_text" in toggleText) {
        headings.push(toggleText.plain_text);
      }
    }
  }

  return headings;
};

// Get existing shopping list items (all unchecked to-dos inside toggle blocks)
const getExistingShoppingListItems = async (pageId: string): Promise<Set<string>> => {
  const blocks = await getAllBlocks(notion, pageId);
  const existingItems = new Set<string>();

  // For each toggle block, get its children (to_dos)
  for (const block of blocks) {
    if ("type" in block && block.type === "toggle" && "has_children" in block && block.has_children) {
      // Get children of this toggle block
      const children = await getAllBlocks(notion, block.id);

      for (const child of children) {
        if ("type" in child && child.type === "to_do" && "to_do" in child) {
          const todo = (child as BlockObjectResponse & { type: "to_do" }).to_do;
          const itemText = todo.rich_text?.[0];
          if (itemText && "plain_text" in itemText && !todo.checked) {
            existingItems.add(itemText.plain_text.toLowerCase());
          }
        }
      }
    }
  }

  return existingItems;
};

// Use AI to categorize items into headings
const categorizeItems = async (
  items: string[],
  headings: string[]
): Promise<Record<string, string[]>> => {
  const prompt = `You are organizing a shopping list. Given these items and existing category headings, assign each item to the most appropriate heading.

Items to categorize:
${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}

Existing headings:
${headings.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Rules:
- Assign each item to exactly one existing heading
- Use common sense (e.g., "Chicken" → "Meat & Fish", "Milk" → "Dairy")
- If an item could fit multiple categories, choose the most specific one
- Do NOT create new headings

Respond with ONLY valid JSON (no markdown):
{
  "categorized": {
    "Heading Name": ["item1", "item2"],
    "Another Heading": ["item3"]
  }
}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
    generationConfig: {
      response_mime_type: "application/json",
    },
  });

  let cleanedText = response.text.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText.replace(/^```json\s*/, "").replace(/\s*```$/, "");
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/^```\s*/, "").replace(/\s*```$/, "");
  }

  const parsed = JSON.parse(cleanedText);
  return parsed.categorized as Record<string, string[]>;
};

// Add items to shopping list under appropriate toggle blocks
const addItemsToShoppingList = async (
  categorized: Record<string, string[]>,
  pageId: string
): Promise<void> => {
  const blocks = await getAllBlocks(notion, pageId);

  for (const [heading, items] of Object.entries(categorized)) {
    // Find the toggle block with matching text
    let toggleBlockId: string | null = null;

    for (const block of blocks) {
      if ("type" in block && block.type === "toggle" && "toggle" in block) {
        const toggle = (block as BlockObjectResponse & { type: "toggle" }).toggle;
        const toggleText = toggle.rich_text?.[0];
        if (toggleText && "plain_text" in toggleText && toggleText.plain_text === heading) {
          toggleBlockId = block.id;
          break;
        }
      }
    }

    if (!toggleBlockId) {
      logger.warn("Toggle block not found, skipping items", { heading, items });
      continue;
    }

    // Create todo blocks
    const todoBlocks = items.map((item) => ({
      object: "block" as const,
      type: "to_do" as const,
      to_do: {
        rich_text: [{ type: "text" as const, text: { content: item } }],
        checked: false,
      },
    }));

    // Add items as children of the toggle block
    await notion.blocks.children.append({
      block_id: toggleBlockId,
      children: todoBlocks,
    });

    logger.success("Added items to shopping list", { heading, count: items.length });
  }
};

// Set default icons for any entries missing them across meals, ingredients, and planner databases
const setDefaultIcons = async (): Promise<void> => {
  const MEAL_ICON = "🍲";
  const INGREDIENT_ICON = "🥫";
  const PLANNER_DAY_ICON = "📅";

  logger.info("Setting default icons...");

  const mealPages = await getAllPages(MEALS_DATABASE_ID, NOTION_TOKEN);
  const mealPagesWithoutIcons = mealPages.filter((page) => !page.icon);
  for (const page of mealPagesWithoutIcons) {
    await notion.pages.update({ page_id: page.id, icon: { type: "emoji", emoji: MEAL_ICON } });
  }
  if (mealPagesWithoutIcons.length > 0) {
    logger.success("Updated meals with icons", { count: mealPagesWithoutIcons.length });
  }

  const ingredientPages = await getAllPages(SHOPPING_HELPER_DATABASE_ID, NOTION_TOKEN);
  const ingredientPagesWithoutIcons = ingredientPages.filter((page) => !page.icon);
  for (const page of ingredientPagesWithoutIcons) {
    await notion.pages.update({ page_id: page.id, icon: { type: "emoji", emoji: INGREDIENT_ICON } });
  }
  if (ingredientPagesWithoutIcons.length > 0) {
    logger.success("Updated ingredients with icons", { count: ingredientPagesWithoutIcons.length });
  }

  const plannerPages = await getAllPages(MEAL_PLANNER_DATABASE_ID, NOTION_TOKEN);
  const plannerPagesWithoutIcons = plannerPages.filter((page) => !page.icon);
  for (const page of plannerPagesWithoutIcons) {
    await notion.pages.update({ page_id: page.id, icon: { type: "emoji", emoji: PLANNER_DAY_ICON } });
  }
  if (plannerPagesWithoutIcons.length > 0) {
    logger.success("Updated planner days with icons", { count: plannerPagesWithoutIcons.length });
  }
};

// Process items for a specific shopping list type
const processShoppingList = async (
  items: HelperItem[],
  listType: ShoppingListType,
  pageId: string
): Promise<number> => {
  const listName = listType === 'grocery' ? 'grocery' :
                   listType === 'turkish' ? 'Turkish' : 'Asian';

  if (items.length === 0) {
    logger.info(`No items checked for ${listName} shopping list`);
    return 0;
  }

  logger.info(`Found items for ${listName} list`, { count: items.length });

  // Get existing shopping list items to avoid duplicates
  const existingShoppingListItems = await getExistingShoppingListItems(pageId);

  // Filter out items that already exist on the shopping list
  const newItemsToAdd = items.filter(
    item => !existingShoppingListItems.has(item.item.toLowerCase())
  );

  if (newItemsToAdd.length === 0) {
    logger.info(`All checked items already exist on ${listName} shopping list`);
    return 0;
  }

  logger.info(`Items to add to ${listName} shopping list`, {
    total: items.length,
    new: newItemsToAdd.length,
    duplicate: items.length - newItemsToAdd.length
  });

  const headings = await getShoppingListHeadings(pageId);
  logger.info(`Found ${listName} shopping list headings`, { headings });

  const itemNames = newItemsToAdd.map((item) => item.item);
  const categorized = await categorizeItems(itemNames, headings);

  await addItemsToShoppingList(categorized, pageId);

  logger.success(`${listName} shopping list updated`, {
    added: newItemsToAdd.length,
    skipped: items.length - newItemsToAdd.length,
  });

  return newItemsToAdd.length;
};

const run = async () => {
  // Step 1: Populate helper database with upcoming meal ingredients
  logger.info("Fetching upcoming meals (next 7 days)...");
  const upcomingMeals = await getUpcomingMeals();
  logger.info("Found upcoming meals", { count: upcomingMeals.length });

  logger.info("Updating ingredients database...");
  const existingHelperItems = await getHelperItems();
  logger.info(`Fetched ${existingHelperItems.length} existing ingredients from database`);
  await populateHelperDatabase(upcomingMeals, existingHelperItems);

  // Step 2: Set default icons for any new entries
  await setDefaultIcons();

  // Step 3: Re-fetch items after populate to get updated state
  const updatedHelperItems = await getHelperItems();

  // Step 4: Process items for each shopping list type
  const groceryItems = updatedHelperItems.filter((item) => item.addToShoppingList);
  const turkishItems = updatedHelperItems.filter((item) => item.addToTurkishList);
  const asianItems = updatedHelperItems.filter((item) => item.addToAsianList);

  let totalAdded = 0;

  // Process grocery list
  totalAdded += await processShoppingList(
    groceryItems,
    'grocery',
    GROCERY_SHOPPING_LIST_PAGE_ID
  );

  // Process Turkish supermarket list
  totalAdded += await processShoppingList(
    turkishItems,
    'turkish',
    TURKISH_SUPERMARKET_LIST_PAGE_ID
  );

  // Process Asian supermarket list
  totalAdded += await processShoppingList(
    asianItems,
    'asian',
    ASIAN_SUPERMARKET_LIST_PAGE_ID
  );

  // Step 5: Process status updates based on user actions (no archiving)
  const now = new Date().toISOString();
  let processedCount = 0;
  let stapleCount = 0;
  let expiredCount = 0;

  // Ingredients needed by a meal in the next 7 days
  const neededIngredients = new Set(
    upcomingMeals.flatMap((meal) => meal.ingredients.map((i) => i.toLowerCase()))
  );

  for (const item of updatedHelperItems) {
    const updates: any = {};
    let shouldUpdate = false;
    const addedToList = item.addToShoppingList || item.addToTurkishList || item.addToAsianList;

    // Handle "Delete" checkbox
    if (item.delete) {
      updates["Processing status"] = { status: { name: "Processed" } };
      updates["Delete"] = { checkbox: false };
      updates["Last processed"] = { date: { start: now } };
      shouldUpdate = true;
      processedCount++;
      logger.info("Marked ingredient as processed (Delete)", { ingredient: item.item });
    }
    // Staples added to a list keep their Staple status
    else if (addedToList && item.processingStatus === "Staple") {
      updates["Add to shopping list"] = { checkbox: false };
      updates["Add to Turkish supermarket shopping list"] = { checkbox: false };
      updates["Add to Asian supermarket shopping list"] = { checkbox: false };
      updates["Last processed"] = { date: { start: now } };
      shouldUpdate = true;
      stapleCount++;
      logger.info("Kept staple after adding to list", { ingredient: item.item });
    }
    // Handle shopping list checkboxes
    else if (addedToList) {
      updates["Processing status"] = { status: { name: "Processed" } };
      updates["Add to shopping list"] = { checkbox: false };
      updates["Add to Turkish supermarket shopping list"] = { checkbox: false };
      updates["Add to Asian supermarket shopping list"] = { checkbox: false };
      updates["Last processed"] = { date: { start: now } };
      shouldUpdate = true;
      processedCount++;
      logger.info("Marked ingredient as processed (added to list)", { ingredient: item.item });
    }
    // Expire suggestions no meal in the next 7 days needs. "Last processed"
    // is left alone, so the item comes back as New next time a meal needs it.
    else if (item.processingStatus === "New" && !neededIngredients.has(item.item.toLowerCase())) {
      updates["Processing status"] = { status: { name: "Processed" } };
      shouldUpdate = true;
      expiredCount++;
      logger.info("Expired unused suggestion (no meal in the next 7 days)", { ingredient: item.item });
    }

    if (shouldUpdate) {
      await notion.pages.update({
        page_id: item.id,
        properties: updates,
      });
    }
  }

  logger.success("Ingredients database workflow complete", {
    totalAdded,
    processed: processedCount,
    staples: stapleCount,
    expired: expiredCount,
  });
};

try {
  await run();
} catch (err) {
  logger.error("Unexpected error", err instanceof Error ? err : undefined);
  process.exit(1);
}