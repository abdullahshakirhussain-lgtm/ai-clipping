/**
 * Minimal dev seed. The app is upload-driven, so there's no demo content to
 * fabricate — this just ensures the default "My Uploads" project exists and
 * wipes any stale domain data. Auth tables are left untouched.
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Wipe domain data in FK order (auth tables untouched).
  await prisma.publishAttempt.deleteMany();
  await prisma.publishJob.deleteMany();
  await prisma.reviewAction.deleteMany();
  await prisma.clipEnhancement.deleteMany();
  await prisma.clip.deleteMany();
  await prisma.transcript.deleteMany();
  await prisma.sourceVideo.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.socialAccount.deleteMany();

  await prisma.campaign.create({
    data: {
      name: "My Uploads",
      allowedPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"],
      status: "ACTIVE",
    },
  });

  console.log("[seed] ready: default 'My Uploads' project created");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
