import type { PrismaClient } from "@prisma/client";
import { CampaignRepository } from "./repositories/campaign.js";
import { ClipRepository } from "./repositories/clip.js";
import { PublishRepository } from "./repositories/publish.js";
import { SocialAccountRepository } from "./repositories/social-account.js";
import { SourceVideoRepository } from "./repositories/source-video.js";

export { getPrisma, disconnectPrisma } from "./client.js";
export * from "./repositories/campaign.js";
export * from "./repositories/clip.js";
export * from "./repositories/publish.js";
export * from "./repositories/social-account.js";
export * from "./repositories/source-video.js";

// Re-export Prisma enums/types the rest of the codebase needs
export {
  Prisma,
  type PrismaClient,
  ClipStatus,
  CampaignStatus,
  Platform,
  SourcePlatform,
  SourceVideoStatus,
  ReviewActionType,
  SocialAccountStatus,
  PublishJobStatus,
  UserRole,
} from "@prisma/client";

export interface Repositories {
  campaigns: CampaignRepository;
  sourceVideos: SourceVideoRepository;
  clips: ClipRepository;
  socialAccounts: SocialAccountRepository;
  publish: PublishRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    campaigns: new CampaignRepository(prisma),
    sourceVideos: new SourceVideoRepository(prisma),
    clips: new ClipRepository(prisma),
    socialAccounts: new SocialAccountRepository(prisma),
    publish: new PublishRepository(prisma),
  };
}
