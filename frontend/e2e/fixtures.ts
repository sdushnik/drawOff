import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

export type Player = { context: BrowserContext; page: Page; name: string };

export class IsolatedPlayerPool {
  private readonly contexts = new Set<BrowserContext>();

  constructor(private readonly browser: Browser) {}

  async create(name: string): Promise<Player> {
    const context = await this.browser.newContext();
    this.contexts.add(context);
    try {
      return { context, page: await context.newPage(), name };
    } catch (error) {
      this.contexts.delete(context);
      await context.close().catch(() => undefined);
      throw error;
    }
  }

  async closeAll(): Promise<void> {
    const contexts = [...this.contexts];
    this.contexts.clear();
    await Promise.all(contexts.map((context) => context.close().catch(() => undefined)));
  }
}

export const test = base.extend<{ players: IsolatedPlayerPool }>({
  players: async ({ browser }, use) => {
    const pool = new IsolatedPlayerPool(browser);
    try {
      await use(pool);
    } finally {
      await pool.closeAll();
    }
  },
});

export { expect };
