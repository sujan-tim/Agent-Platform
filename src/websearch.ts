/**
 * Live web search, so the agent can answer about things that happened after
 * its model was trained: news, prices, people, anything not in the company's
 * documents.
 *
 * Uses Tavily (https://tavily.com), a search API made for AI agents: free for
 * 1,000 searches a month, no card. Set TAVILY_API_KEY to turn it on; without
 * it the web tools are simply not offered. Pages are fetched by Tavily's
 * servers, never by this one, so a link the model picks cannot reach this
 * server's private network.
 */

export interface WebResult {
  title: string;
  url: string;
  /** A summary of the relevant part of the page. */
  content: string;
  publishedDate?: string;
}

export interface WebSearcher {
  readonly name: string;
  search(query: string, options?: { news?: boolean; days?: number; maxResults?: number }): Promise<WebResult[]>;
  /** The readable text of one page. */
  read(url: string): Promise<string>;
}

const TIMEOUT_MS = 30_000;

export class TavilySearcher implements WebSearcher {
  readonly name = 'tavily';

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl = 'https://api.tavily.com',
  ) {}

  async search(query: string, options: { news?: boolean; days?: number; maxResults?: number } = {}): Promise<WebResult[]> {
    const body = await this.post('/search', {
      query,
      topic: options.news ? 'news' : 'general',
      search_depth: 'basic',
      max_results: options.maxResults ?? 5,
      include_published_date: true,
      ...(options.days && { time_range: toTimeRange(options.days) }),
    });
    const results = (body.results ?? []) as Array<{ title?: string; url?: string; content?: string; published_date?: string | null }>;
    return results
      .filter((r) => r.url)
      .map((r) => ({
        title: r.title ?? r.url!,
        url: r.url!,
        content: r.content ?? '',
        ...(r.published_date && { publishedDate: r.published_date }),
      }));
  }

  async read(url: string): Promise<string> {
    const body = await this.post('/extract', { urls: [url], extract_depth: 'basic', format: 'markdown' });
    const page = (body.results as Array<{ raw_content?: string }> | undefined)?.[0];
    if (!page?.raw_content) {
      const failure = (body.failed_results as Array<{ error?: string }> | undefined)?.[0]?.error;
      throw new Error(`That page could not be read${failure ? `: ${failure}` : '.'}`);
    }
    return page.raw_content;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Error('Could not reach the web search service.');
    }
    if (res.status === 401) throw new Error('The web search service rejected its API key (TAVILY_API_KEY).');
    if (res.status === 429) throw new Error('Too many web searches at once; try again in a minute.');
    if (res.status === 432 || res.status === 433) throw new Error("This server's monthly web search allowance is used up.");
    if (!res.ok) throw new Error(`The web search service returned ${res.status}.`);
    return (await res.json()) as Record<string, unknown>;
  }
}

/** Tavily filters by day, week, month or year; this picks the smallest that covers `days`. */
function toTimeRange(days: number): string {
  if (days <= 1) return 'day';
  if (days <= 7) return 'week';
  if (days <= 31) return 'month';
  return 'year';
}

export function createWebSearcher(env: NodeJS.ProcessEnv = process.env): WebSearcher | undefined {
  return env.TAVILY_API_KEY ? new TavilySearcher(env.TAVILY_API_KEY) : undefined;
}
