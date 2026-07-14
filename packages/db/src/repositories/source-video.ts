import type { PrismaClient, Prisma, SourceVideoStatus } from "@prisma/client";

export class SourceVideoRepository {
  constructor(private readonly prisma: PrismaClient) {}

  create(data: Prisma.SourceVideoUncheckedCreateInput) {
    return this.prisma.sourceVideo.create({ data });
  }

  byId(id: string) {
    return this.prisma.sourceVideo.findUnique({
      where: { id },
      include: {
        transcript: true,
        campaign: true,
        clips: { orderBy: { startSec: "asc" }, include: { enhancement: true } },
      },
    });
  }

  list(filter?: { campaignId?: string; status?: SourceVideoStatus }) {
    return this.prisma.sourceVideo.findMany({
      where: {
        campaignId: filter?.campaignId,
        status: filter?.status,
      },
      include: {
        campaign: true,
        _count: { select: { clips: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    });
  }

  update(id: string, data: Prisma.SourceVideoUncheckedUpdateInput) {
    return this.prisma.sourceVideo.update({ where: { id }, data });
  }

  /** Guarded status transition: only moves forward when the row is in `from`. */
  async transition(id: string, from: SourceVideoStatus[], to: SourceVideoStatus) {
    const result = await this.prisma.sourceVideo.updateMany({
      where: { id, status: { in: from } },
      data: { status: to },
    });
    return result.count === 1;
  }

  countByStatus(): Promise<Array<{ status: SourceVideoStatus; count: number }>> {
    return this.prisma.sourceVideo
      .groupBy({ by: ["status"], _count: true })
      .then((rows) => rows.map((r) => ({ status: r.status, count: r._count })));
  }

  upsertTranscript(
    sourceVideoId: string,
    data: { language: string; fullText: string; segments: Prisma.InputJsonValue; provider: string },
  ) {
    return this.prisma.transcript.upsert({
      where: { sourceVideoId },
      create: { sourceVideoId, ...data },
      update: data,
    });
  }
}
