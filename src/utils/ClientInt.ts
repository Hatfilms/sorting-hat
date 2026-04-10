import { Client, Collection } from 'discord.js';

export type HouseRankingResult = {
  roleName: string;
  membersCount: number;
};

type HouseRankingCacheEntry = {
  data: HouseRankingResult[];
  expiresAt: number;
};

export class ClientInt extends Client {
  commands: Collection<string, any>;
  slashSubcommands: Collection<string, any>;
  private houseRankingCache: Collection<string, HouseRankingCacheEntry>;
  private houseRankingInFlight: Collection<
    string,
    Promise<HouseRankingResult[]>
  >;
  private readonly houseRankingTtlMs: number;

  constructor(options: any) {
    super(options);
    this.commands = new Collection();
    this.slashSubcommands = new Collection();
    this.houseRankingCache = new Collection();
    this.houseRankingInFlight = new Collection();
    this.houseRankingTtlMs = 60 * 60 * 1000;
  }

  getHouseRankingCache(guildId: string): HouseRankingResult[] | null {
    const cached = this.houseRankingCache.get(guildId);
    if (!cached) {
      return null;
    }

    if (Date.now() > cached.expiresAt) {
      this.houseRankingCache.delete(guildId);
      return null;
    }

    return cached.data;
  }

  setHouseRankingCache(guildId: string, data: HouseRankingResult[]) {
    this.houseRankingCache.set(guildId, {
      data,
      expiresAt: Date.now() + this.houseRankingTtlMs,
    });
  }

  invalidateHouseRankingCache(guildId?: string | null) {
    if (!guildId) {
      return;
    }

    this.houseRankingCache.delete(guildId);
    this.houseRankingInFlight.delete(guildId);
  }

  getHouseRankingInFlight(guildId: string) {
    return this.houseRankingInFlight.get(guildId) ?? null;
  }

  setHouseRankingInFlight(
    guildId: string,
    promise: Promise<HouseRankingResult[]>,
  ) {
    this.houseRankingInFlight.set(guildId, promise);
  }

  clearHouseRankingInFlight(guildId: string) {
    this.houseRankingInFlight.delete(guildId);
  }
}
