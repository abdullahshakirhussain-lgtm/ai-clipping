import { getPrisma } from "@clipfactory/db";

/** Admin utilities. */
export class SystemService {
  /**
   * Wipe ALL domain data (videos, clips, jobs, accounts, calibration) — a hard
   * reset of the site. Auth/user tables are left untouched. Irreversible.
   */
  async wipeAll(): Promise<{ wiped: true }> {
    const prisma = getPrisma();
    await prisma.$transaction([
      prisma.publishAttempt.deleteMany(),
      prisma.publishJob.deleteMany(),
      prisma.reviewAction.deleteMany(),
      prisma.clipEnhancement.deleteMany(),
      prisma.clip.deleteMany(),
      prisma.transcript.deleteMany(),
      prisma.sourceVideo.deleteMany(),
      prisma.campaign.deleteMany(),
      prisma.socialAccount.deleteMany(),
      prisma.calibration.deleteMany(),
    ]);
    return { wiped: true };
  }
}
