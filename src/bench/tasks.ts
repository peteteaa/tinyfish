// The benchmark's tasks: real public pages, each checked with TinyFish Fetch on 2026-10-16. Expectations are anchored
// on things that rarely change (plan names, the sandbox shops' fixed catalogues, list sizes) rather than exact prices
// or job titles, so a failure means the run broke, not that the page was updated.

import type { Expectation } from "./grade.js";

export interface BenchTask {
  /** snake_case; the saved workflow is named bench_<id>. */
  id: string;
  category: "pricing" | "products" | "jobs";
  goal: string;
  expect: Expectation[];
}

const PRICE_USD = "\\$\\s?\\d";
const PRICE_GBP = "£\\s?\\d+\\.\\d\\d";
const NAME = "name|title|plan|tier";
const ROLE = "title|role|position|name";

export const TASKS: BenchTask[] = [
  // ---------- pricing ----------
  {
    id: "vercel_pricing",
    category: "pricing",
    goal: "Get the pricing plans on vercel.com/pricing: each plan's name, monthly price and key features.",
    expect: [
      { type: "contains", values: ["Hobby", "Pro", "Enterprise"] },
      { type: "pattern", pattern: PRICE_USD, min: 1 },
      { type: "records", min: 3, fields: [NAME] },
    ],
  },
  {
    id: "supabase_pricing",
    category: "pricing",
    goal: "Get the pricing plans on supabase.com/pricing: each plan's name, monthly price and key features.",
    expect: [
      { type: "contains", values: ["Free", "Pro", "Team", "Enterprise"] },
      { type: "pattern", pattern: PRICE_USD, min: 2 },
      { type: "records", min: 4, fields: [NAME] },
    ],
  },
  {
    id: "linear_pricing",
    category: "pricing",
    goal: "Get the pricing plans on linear.app/pricing: each plan's name, price per user and key features.",
    expect: [
      { type: "contains", values: ["Free", "Basic", "Business", "Enterprise"] },
      { type: "pattern", pattern: PRICE_USD, min: 2 },
      { type: "records", min: 4, fields: [NAME] },
    ],
  },
  {
    id: "github_pricing",
    category: "pricing",
    goal: "Get the plans on github.com/pricing: each plan's name, price per user per month and key features.",
    expect: [
      { type: "contains", values: ["Free", "Team", "Enterprise"] },
      { type: "pattern", pattern: PRICE_USD, min: 2 },
      { type: "records", min: 3, fields: [NAME] },
    ],
  },
  {
    id: "netlify_pricing",
    category: "pricing",
    goal: "Get the pricing plans on netlify.com/pricing: each plan's name, monthly price and key features.",
    expect: [
      { type: "contains", values: ["Free", "Pro", "Enterprise"] },
      { type: "pattern", pattern: PRICE_USD, min: 1 },
      { type: "records", min: 3, fields: [NAME] },
    ],
  },

  // ---------- product listings ----------
  {
    id: "books_travel",
    category: "products",
    goal:
      "List every book in the Travel category of books.toscrape.com " +
      "(books.toscrape.com/catalogue/category/books/travel_2/index.html) with its title, price and star rating.",
    expect: [
      { type: "contains", values: ["Himalayas"] },
      { type: "pattern", pattern: PRICE_GBP, min: 11 },
      { type: "records", min: 11, fields: ["title|name", "price"] },
    ],
  },
  {
    id: "scrapeme_shop",
    category: "products",
    goal: "List the products on the first page of scrapeme.live/shop with each product's name and price.",
    expect: [
      { type: "contains", values: ["Bulbasaur", "Charmander"] },
      // The page lists 16, but TinyFish Fetch's text holds 15 of them (checked 2026-10-16), so 15 is the most either mode can see.
      { type: "pattern", pattern: PRICE_GBP, min: 15 },
      { type: "records", min: 15, fields: ["name|title", "price"] },
    ],
  },
  {
    id: "webscraper_laptops",
    category: "products",
    goal:
      "List the first 10 laptops on webscraper.io/test-sites/e-commerce/allinone/computers/laptops with each " +
      "laptop's name, price and number of reviews.",
    expect: [
      { type: "pattern", pattern: PRICE_USD, min: 10 },
      { type: "records", min: 10, fields: ["name|title|model", "price"] },
    ],
  },
  {
    id: "hn_front_page",
    category: "products",
    goal: "List the top 10 stories on the Hacker News front page (news.ycombinator.com) with title, link and points.",
    expect: [{ type: "records", min: 10, fields: ["title|headline", "point|score"] }],
  },
  {
    id: "github_trending",
    category: "products",
    goal: "List the repositories on github.com/trending today with each repo's owner/name, description and language.",
    expect: [{ type: "records", min: 5, fields: ["name|repo"] }],
  },

  // ---------- job postings ----------
  {
    id: "anthropic_jobs",
    category: "jobs",
    goal: "List 15 open roles on Anthropic's job board (job-boards.greenhouse.io/anthropic) with title and location.",
    expect: [
      { type: "contains", values: ["Anthropic"] },
      { type: "records", min: 15, fields: [ROLE, "location"] },
    ],
  },
  {
    id: "openai_jobs",
    category: "jobs",
    goal: "List 15 open roles on OpenAI's job board (jobs.ashbyhq.com/openai) with title, team and location.",
    expect: [{ type: "records", min: 15, fields: [ROLE, "location"] }],
  },
  {
    id: "palantir_jobs",
    category: "jobs",
    goal: "List the open roles shown on Palantir's Lever job board (jobs.lever.co/palantir) with title and location.",
    expect: [{ type: "records", min: 3, fields: [ROLE, "location"] }],
  },
  {
    id: "wwr_programming_jobs",
    category: "jobs",
    goal:
      "List the 10 newest remote programming jobs on We Work Remotely " +
      "(weworkremotely.com/categories/remote-programming-jobs) with title and company.",
    expect: [{ type: "records", min: 10, fields: [ROLE, "company"] }],
  },
  {
    id: "yc_jobs",
    category: "jobs",
    goal: "List the startup jobs featured on Y Combinator's job board (ycombinator.com/jobs) with role and company.",
    expect: [{ type: "records", min: 5, fields: [ROLE, "company|startup"] }],
  },
];

export function selectTasks(ids?: string): BenchTask[] {
  if (!ids) return TASKS;
  const wanted = ids.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length) throw new Error(`Unknown task(s): ${unknown.join(", ")}. Known: ${TASKS.map((t) => t.id).join(", ")}`);
  return TASKS.filter((t) => wanted.includes(t.id));
}
