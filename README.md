# Notion Workflows

A collection of automated workflows that manage and enrich Notion databases — from meal planning and shopping lists to travel guides and pub crawl routes. Runs nightly via GitHub Actions using TypeScript, the Notion API, and Google Gemini AI.

## Workflows

### Cleanup Shopping

Deletes checked-off to-do items from Notion shopping list pages and ensures every heading retains at least one empty to-do beneath it. Reused across multiple lists (grocery, Turkish supermarket, Asian supermarket, and general to-do).

```sh
npx tsx workflows/cleanup-shopping/index.ts
```

### Create Standup

Creates the next working day's page in a Notion "Standups" database from its template, then fills the "What have I done since yesterday" section with a Gemini summary of the day's Azure DevOps activity (state changes and comments you made). Only fills the section while it's still an empty placeholder, reuses the page if one already exists for that date, and only ever reads from Azure DevOps. Runs Monday to Friday evenings, so Friday's work goes on Monday's page.

```sh
npx tsx workflows/create-standup/index.ts
# Log the summary without touching Notion, for a chosen day:
DRY_RUN=true ACTIVITY_DATE=2026-09-24 npx tsx workflows/create-standup/index.ts
```

### Events Calendar

Generates recurring calendar events in a Notion "Events" database from templates defined in a "Repeat Events" database. Reads weekday, week ordinal, and excluded months from each template, then creates events for the next 12 months — skipping any that already exist.

```sh
npx tsx workflows/events-calendar/index.ts
```

### Manage Meal Planner

Maintains a rolling 28-day meal planner. Archives past days, creates missing future day pages, and corrects any incorrectly formatted day names.

```sh
npx tsx workflows/manage-meal-planner/index.ts
```

### Manage Shopping

End-to-end shopping list manager. Queries the meal planner for the next 7 days' meals, extracts their ingredients into a "Shopping Helper" database, then uses **Gemini AI** to categorize checked items under the correct heading on each shopping list page. Processed items are archived automatically.

```sh
npx tsx workflows/manage-shopping/index.ts
```

### Populate Films & TV

Enriches a films/TV database with metadata from **TMDB** and **OMDb** APIs — poster images, overview, runtime, genres, directors, writers, countries, year, IMDB score, Tomatometer, and Metascore.

```sh
npx tsx workflows/populate-films-and-tv/index.ts
```

### Populate Meals

Uses **Gemini AI** to auto-complete meal recipes with ingredients and cooking instructions. Follows British English naming conventions and specific formatting rules defined in a prompt template.

```sh
npx tsx workflows/populate-meals/index.ts
```

### Populate Pubs

Calculates an optimal pub crawl route for a given location. Extracts geolocation from Notion's Place property, computes distances using the Haversine formula, optimizes visit order via a nearest-neighbour algorithm, and appends a Google Maps walking route link.

```sh
npx tsx workflows/populate-pubs/index.ts
```

### Populate Travel Database

Uses **Gemini AI** to annotate travel destinations with typical stay length, best season, highlights, activities, flight options (from Leeds/Manchester/London), and transport information.

```sh
npx tsx workflows/populate-travel-database/index.ts
```

### Populate Walks Database

Uses **Gemini AI** to annotate walking locations with distance from home, transport options, walk type, parking, routes, terrain, and nearby pubs.

```sh
npx tsx workflows/populate-walks-database/index.ts
```

## Tech Stack

- **Runtime:** Node.js 22, TypeScript via [tsx](https://github.com/privatenumber/tsx)
- **Notion:** [`@notionhq/client`](https://github.com/makenotion/notion-sdk-js)
- **AI:** [`@google/genai`](https://github.com/googleapis/js-genai) (Gemini 2.5 Flash, JSON response mode)
- **Work tracking:** [Azure DevOps REST API](https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/) (read-only)
- **Film APIs:** [TMDB](https://www.themoviedb.org/documentation/api), [OMDb](https://www.omdbapi.com/)
- **CI:** GitHub Actions on nightly cron schedules (all workflows also support `workflow_dispatch`)

## Project Structure

```
utils/
  ai.ts          # Gemini AI client and batch annotation helper
  logger.ts      # Structured logger with log levels
  notion.ts      # Notion client, page/block CRUD helpers
  parsing.ts     # Property builders for Notion API requests
workflows/
  cleanup-shopping/       # Remove checked items from shopping lists
  create-standup/         # Next standup page with Azure DevOps summary
  events-calendar/        # Generate recurring calendar events
  manage-meal-planner/    # Rolling 28-day meal planner
  manage-shopping/        # AI-powered shopping list management
  populate-films-and-tv/  # TMDB/OMDb metadata enrichment
  populate-meals/         # AI-generated recipes
  populate-pubs/          # Optimal pub crawl routing
  populate-travel-database/  # AI travel destination annotations
  populate-walks-database/   # AI walking location annotations
```

## Setup

1. **Install dependencies:**

   ```sh
   npm install
   ```

2. **Configure environment variables:**

   All secrets are managed via GitHub Actions. For local development, create a `.env` file:

   ```env
   # Notion
   NOTION_TOKEN=secret_...
   PRIVATE_INTEGRATION_TOKEN=secret_...    # For private databases

   # Database / Page IDs
   MEAL_PLANNER_DATABASE_ID=...
   MEALS_DATABASE_ID=...
   SHOPPING_HELPER_DATABASE_ID=...
   GROCERY_SHOPPING_LIST_PAGE_ID=...
   TURKISH_SUPERMARKET_LIST_PAGE_ID=...
   ASIAN_SUPERMARKET_LIST_PAGE_ID=...
   EVENTS_DATABASE_ID=...
   REPEAT_EVENTS_DATABASE_ID=...
   FILMS_DATABASE_ID=...
   TRAVEL_DATABASE_ID=...
   WALKS_DATABASE_ID=...
   PUBS_DATABASE_ID=...
   PUBS_PAGE_ID=...
   STANDUPS_DATABASE_ID=...

   # APIs
   GEMINI_API_KEY=...
   TMDB_API_KEY=...
   OMDB_API_KEY=...

   # Azure DevOps (PAT scoped to Work Items: Read only)
   ADO_ORG=...
   ADO_PROJECT=...
   ADO_PAT=...

   # Location
   HOME_LOCATION=...
   STATION_WAYPOINT=...
   LOCATION=...
   ```

3. **Run a workflow locally:**

   ```sh
   npx tsx workflows/<workflow-name>/index.ts
   ```
