import type { Repositories } from "@clipfactory/db";
import type { CreateAccountInput, SocialAccountDto, UpdateAccountInput } from "../contracts/index.js";
import { NotFoundError } from "../errors.js";
import { toAccountDto } from "../mappers.js";

export class AccountService {
  constructor(private readonly repos: Repositories) {}

  async list(): Promise<SocialAccountDto[]> {
    const rows = await this.repos.socialAccounts.list();
    return rows.map(toAccountDto);
  }

  async create(input: CreateAccountInput): Promise<SocialAccountDto> {
    const created = await this.repos.socialAccounts.create({
      platform: input.platform,
      handle: input.handle,
      displayName: input.displayName,
      category: input.category,
      channelId: input.channelId,
      postsPerDay: input.postsPerDay,
      activeStartHour: input.activeStartHour,
      activeEndHour: input.activeEndHour,
      timezone: input.timezone,
      credentials: (input.credentials ?? undefined) as never,
    });
    // Re-read with the _count relation the DTO mapper needs
    const rows = await this.repos.socialAccounts.list();
    const row = rows.find((r) => r.id === created.id)!;
    return toAccountDto(row);
  }

  async update(id: string, input: UpdateAccountInput): Promise<SocialAccountDto> {
    const existing = await this.repos.socialAccounts.byId(id);
    if (!existing) throw new NotFoundError("SocialAccount", id);
    await this.repos.socialAccounts.update(id, {
      displayName: input.displayName,
      status: input.status,
      category: input.category,
      channelId: input.channelId,
      postsPerDay: input.postsPerDay,
      activeStartHour: input.activeStartHour,
      activeEndHour: input.activeEndHour,
      timezone: input.timezone,
      credentials: (input.credentials ?? undefined) as never,
    });
    const rows = await this.repos.socialAccounts.list();
    const row = rows.find((r) => r.id === id)!;
    return toAccountDto(row);
  }
}
