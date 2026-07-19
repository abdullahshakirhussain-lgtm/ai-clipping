import type { PrismaClient } from "@prisma/client";
import { CalibrationRepository } from "./repositories/calibration.js";
import { CampaignRepository } from "./repositories/campaign.js";
import { CategoryRepository } from "./repositories/category.js";
import { DiscoveredVideoRepository } from "./repositories/discovered-video.js";
import { ClipRepository } from "./repositories/clip.js";
import { PublishRepository } from "./repositories/publish.js";
import { SocialAccountRepository } from "./repositories/social-account.js";
import { SourceVideoRepository } from "./repositories/source-video.js";

export { getPrisma, disconnectPrisma } from "./client.js";
export * from "./repositories/calibration.js";
export * from "./repositories/campaign.js";
export * from "./repositories/category.js";
export * from "./repositories/discovered-video.js";
export * from "./repositories/clip.js";
export * from "./repositories/publish.js";
export * from "./repositories/social-account.js";
export * from "./repositories/source-video.js";

// Re-export Prisma enums/types the rest of the codebase needs
export {
  Prisma,
  type PrismaClient,
  ClipStatus,
  ClipOutcome,
  CampaignStatus,
  Platform,
  SourcePlatform,
  SourceVideoStatus,
  ReviewActionType,
  SocialAccountStatus,
  PublishJobStatus,
  DiscoveredVideoStatus,
  UserRole,
} from "@prisma/client";

export interface Repositories {
  campaigns: CampaignRepository;
  sourceVideos: SourceVideoRepository;
  clips: ClipRepository;
  socialAccounts: SocialAccountRepository;
  publish: PublishRepository;
  calibration: CalibrationRepository;
  categories: CategoryRepository;
  discovered: DiscoveredVideoRepository;
}

export function createRepositories(prisma: PrismaClient): Repositories {
  return {
    campaigns: new CampaignRepository(prisma),
    sourceVideos: new SourceVideoRepository(prisma),
    clips: new ClipRepository(prisma),
    socialAccounts: new SocialAccountRepository(prisma),
    publish: new PublishRepository(prisma),
    calibration: new CalibrationRepository(prisma),
    categories: new CategoryRepository(prisma),
    discovered: new DiscoveredVideoRepository(prisma),
  };
}
