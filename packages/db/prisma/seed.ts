/**
 * Seeds demo data so the dashboard is populated on first run.
 * Wipes and recreates domain tables (auth tables are left untouched).
 */
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

const HOOKS = [
  "He said THIS live on stream...",
  "Nobody expected this answer",
  "The one habit that changed everything",
  "Wait for the plot twist at the end",
  "This take is going to be controversial",
  "The 30-second explanation everyone needed",
];

const TRANSCRIPT_SEGMENTS = Array.from({ length: 36 }, (_, i) => ({
  start: i * 5,
  end: i * 5 + 5,
  text: `Segment ${i + 1}: this is demo transcript text covering seconds ${i * 5} to ${i * 5 + 5}.`,
}));

async function main() {
  // Wipe domain data in FK order
  await prisma.clipMetric.deleteMany();
  await prisma.clipFeature.deleteMany();
  await prisma.publishAttempt.deleteMany();
  await prisma.publishJob.deleteMany();
  await prisma.reviewAction.deleteMany();
  await prisma.clipEnhancement.deleteMany();
  await prisma.clip.deleteMany();
  await prisma.transcript.deleteMany();
  await prisma.sourceVideo.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.socialAccount.deleteMany();
  await prisma.creator.deleteMany();

  const alex = await prisma.creator.create({
    data: { name: "Alex Rivera", handle: "alexrivera", notes: "Podcast — business & startups" },
  });
  const maya = await prisma.creator.create({
    data: { name: "Maya Chen", handle: "mayachen", notes: "Gaming streams, high energy" },
  });

  const accounts = await Promise.all([
    prisma.socialAccount.create({
      data: { platform: "TIKTOK", handle: "@clipfactory.tk", displayName: "ClipFactory TikTok", dailyQuota: 30 },
    }),
    prisma.socialAccount.create({
      data: { platform: "INSTAGRAM", handle: "@clipfactory.ig", displayName: "ClipFactory Reels", dailyQuota: 25 },
    }),
    prisma.socialAccount.create({
      data: { platform: "YOUTUBE", handle: "@clipfactory.yt", displayName: "ClipFactory Shorts", dailyQuota: 20 },
    }),
  ]);

  const campaign = await prisma.campaign.create({
    data: {
      creatorId: alex.id,
      name: "Startup Podcast — Episode 42",
      sourceVideoUrl: "https://www.youtube.com/watch?v=demo-ep42",
      sourcePlatform: "YOUTUBE",
      allowedPlatforms: ["TIKTOK", "INSTAGRAM", "YOUTUBE"],
      revenueRatePerMille: new Prisma.Decimal("1.25"),
      rules: { watermark: true, bannedWords: ["sponsor-x"], minDurationSec: 15, maxDurationSec: 60 },
      status: "ACTIVE",
      expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
    },
  });

  await prisma.campaign.create({
    data: {
      creatorId: maya.id,
      name: "Ranked Grind Highlights — Week 27",
      sourceVideoUrl: "https://www.twitch.tv/videos/demo-week27",
      sourcePlatform: "TWITCH",
      allowedPlatforms: ["TIKTOK", "YOUTUBE"],
      revenueRatePerMille: new Prisma.Decimal("0.90"),
      rules: { watermark: false, minDurationSec: 10, maxDurationSec: 45 },
      status: "DRAFT",
    },
  });

  const video = await prisma.sourceVideo.create({
    data: {
      campaignId: campaign.id,
      originalUrl: campaign.sourceVideoUrl,
      status: "PROCESSED",
      title: "Episode 42 — Bootstrapping to $1M ARR",
      durationSec: 180,
      width: 1920,
      height: 1080,
      metadata: { fps: 30, codec: "h264", note: "seeded demo video (no media file)" },
    },
  });

  await prisma.transcript.create({
    data: {
      sourceVideoId: video.id,
      language: "en",
      provider: "mock",
      fullText: TRANSCRIPT_SEGMENTS.map((s) => s.text).join(" "),
      segments: TRANSCRIPT_SEGMENTS,
    },
  });

  // Clips in a spread of statuses. Seeded clips have no media file on disk;
  // the UI shows a placeholder. Clips produced by the real pipeline have files.
  const clipSpecs: Array<{ start: number; end: number; status: "READY_FOR_REVIEW" | "APPROVED" | "REJECTED" | "PUBLISHED"; hook: string }> = [
    { start: 5, end: 35, status: "READY_FOR_REVIEW", hook: HOOKS[0]! },
    { start: 40, end: 68, status: "READY_FOR_REVIEW", hook: HOOKS[1]! },
    { start: 70, end: 102, status: "READY_FOR_REVIEW", hook: HOOKS[2]! },
    { start: 105, end: 140, status: "READY_FOR_REVIEW", hook: HOOKS[3]! },
    { start: 12, end: 44, status: "APPROVED", hook: HOOKS[4]! },
    { start: 90, end: 120, status: "REJECTED", hook: HOOKS[5]! },
    { start: 20, end: 55, status: "PUBLISHED", hook: HOOKS[0]! },
    { start: 130, end: 165, status: "PUBLISHED", hook: HOOKS[1]! },
  ];

  let i = 0;
  for (const spec of clipSpecs) {
    i += 1;
    const clip = await prisma.clip.create({
      data: {
        sourceVideoId: video.id,
        campaignId: campaign.id,
        startSec: spec.start,
        endSec: spec.end,
        status: spec.status,
        detectionReason: "High emotional intensity + complete story arc in window",
        captionStyle: "bold-center",
        enhancement: {
          create: {
            title: `Ep42 Moment #${i}: ${spec.hook.slice(0, 40)}`,
            description: `Clipped from Startup Podcast Episode 42. ${spec.hook}`,
            hashtags: ["#startup", "#podcast", "#entrepreneur", "#shorts"],
            hooks: { variants: [spec.hook, `POV: ${spec.hook}`, `${spec.hook} (part ${i})`], selectedIndex: 0 },
            qualityScore: 62 + i * 4,
            viralScore: 55 + ((i * 7) % 35),
            estimatedEngagement: 4.5 + (i % 4),
            model: "mock",
          },
        },
      },
    });

    if (spec.status === "PUBLISHED") {
      const account = accounts[i % accounts.length]!;
      const publishedAt = new Date(Date.now() - (10 - i) * 24 * 3600 * 1000);
      const job = await prisma.publishJob.create({
        data: {
          clipId: clip.id,
          socialAccountId: account.id,
          status: "PUBLISHED",
          attempts: 1,
          externalPostId: `mock-post-${clip.id.slice(-6)}`,
          externalUrl: `https://example.com/p/mock-post-${clip.id.slice(-6)}`,
          publishedAt,
          publishAttempts: {
            create: { success: true, finishedAt: publishedAt, response: { driver: "mock", ok: true } },
          },
        },
      });

      // A few days of growing metrics
      let views = 1200 * i;
      for (let d = 0; d < 5; d++) {
        views = Math.round(views * (1.6 - d * 0.1));
        const revenue = (views / 1000) * Number(campaign.revenueRatePerMille);
        await prisma.clipMetric.create({
          data: {
            publishJobId: job.id,
            clipId: clip.id,
            campaignId: campaign.id,
            platform: account.platform,
            capturedAt: new Date(publishedAt.getTime() + d * 24 * 3600 * 1000),
            views,
            likes: Math.round(views * 0.08),
            comments: Math.round(views * 0.011),
            shares: Math.round(views * 0.02),
            watchTimeSec: views * 21,
            revenue: new Prisma.Decimal(revenue.toFixed(4)),
            rpm: campaign.revenueRatePerMille,
          },
        });
      }

      await prisma.clipFeature.create({
        data: {
          clipId: clip.id,
          creatorId: alex.id,
          campaignId: campaign.id,
          platform: account.platform,
          hookText: spec.hook,
          topic: "startups",
          durationSec: spec.end - spec.start,
          captionStyle: "bold-center",
          publishedAt,
          publishedHour: publishedAt.getUTCHours(),
          publishedDayOfWeek: publishedAt.getUTCDay(),
          views,
          likes: Math.round(views * 0.08),
          comments: Math.round(views * 0.011),
          shares: Math.round(views * 0.02),
          watchTimeSec: views * 21,
          revenue: new Prisma.Decimal(((views / 1000) * Number(campaign.revenueRatePerMille)).toFixed(4)),
          engagementRate: 0.11,
        },
      });
    }
  }

  console.log("[seed] done: 2 creators, 2 campaigns, 1 source video, 8 clips, 3 accounts");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
