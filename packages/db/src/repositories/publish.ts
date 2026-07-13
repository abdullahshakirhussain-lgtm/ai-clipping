import type { PrismaClient, Prisma, PublishJobStatus } from "@prisma/client";

const jobInclude = {
  clip: { include: { enhancement: true, campaign: true } },
  socialAccount: true,
  publishAttempts: { orderBy: { startedAt: "desc" as const } },
} satisfies Prisma.PublishJobInclude;

export type PublishJobDetail = Prisma.PublishJobGetPayload<{ include: typeof jobInclude }>;

export class PublishRepository {
  constructor(private readonly prisma: PrismaClient) {}

  createJobs(rows: Prisma.PublishJobUncheckedCreateInput[]) {
    return this.prisma.$transaction(
      rows.map((data) => this.prisma.publishJob.create({ data, include: jobInclude })),
    );
  }

  byId(id: string): Promise<PublishJobDetail | null> {
    return this.prisma.publishJob.findUnique({ where: { id }, include: jobInclude });
  }

  list(filter?: { status?: PublishJobStatus | PublishJobStatus[]; clipId?: string }) {
    return this.prisma.publishJob.findMany({
      where: {
        status: Array.isArray(filter?.status) ? { in: filter.status } : filter?.status,
        clipId: filter?.clipId,
      },
      include: jobInclude,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  update(id: string, data: Prisma.PublishJobUncheckedUpdateInput) {
    return this.prisma.publishJob.update({ where: { id }, data, include: jobInclude });
  }

  /** Scheduled/queued slot times already assigned to an account (for cadence collisions). */
  scheduledTimesForAccount(socialAccountId: string): Promise<Date[]> {
    return this.prisma.publishJob
      .findMany({
        where: {
          socialAccountId,
          status: { in: ["SCHEDULED", "QUEUED"] },
          scheduledAt: { not: null },
        },
        select: { scheduledAt: true },
      })
      .then((rows) => rows.map((r) => r.scheduledAt).filter((d): d is Date => d !== null));
  }

  /** Jobs for one account in the given statuses, soonest scheduled first. */
  forAccount(socialAccountId: string, statuses: PublishJobStatus[]) {
    return this.prisma.publishJob.findMany({
      where: { socialAccountId, status: { in: statuses } },
      include: jobInclude,
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "asc" }],
      take: 300,
    });
  }

  /** Count of PUBLISHED jobs per account since `date` (today's progress). */
  publishedCountsByAccount(since: Date): Promise<Array<{ socialAccountId: string; count: number }>> {
    return this.prisma.publishJob
      .groupBy({
        by: ["socialAccountId"],
        where: { status: "PUBLISHED", publishedAt: { gte: since } },
        _count: true,
      })
      .then((rows) => rows.map((r) => ({ socialAccountId: r.socialAccountId, count: r._count })));
  }

  /** Count of still-pending (SCHEDULED) jobs per account. */
  pendingCountsByAccount(): Promise<Array<{ socialAccountId: string; count: number }>> {
    return this.prisma.publishJob
      .groupBy({ by: ["socialAccountId"], where: { status: "SCHEDULED" }, _count: true })
      .then((rows) => rows.map((r) => ({ socialAccountId: r.socialAccountId, count: r._count })));
  }

  /** Guarded transition; returns false when the job was not in `from`. */
  async transition(id: string, from: PublishJobStatus[], to: PublishJobStatus) {
    const result = await this.prisma.publishJob.updateMany({
      where: { id, status: { in: from } },
      data: { status: to },
    });
    return result.count === 1;
  }

  addAttempt(publishJobId: string, data: { success: boolean; response?: Prisma.InputJsonValue; finishedAt?: Date }) {
    return this.prisma.publishAttempt.create({
      data: { publishJobId, finishedAt: data.finishedAt ?? new Date(), ...data },
    });
  }

  countPublishedSince(date: Date): Promise<number> {
    return this.prisma.publishJob.count({
      where: { status: "PUBLISHED", publishedAt: { gte: date } },
    });
  }

  /** All currently published jobs (for the analytics sync loop). */
  published() {
    return this.prisma.publishJob.findMany({
      where: { status: "PUBLISHED", externalPostId: { not: null } },
      include: jobInclude,
    });
  }

  /** Scheduled jobs whose time has come (for the scheduler tick). */
  due(now: Date) {
    return this.prisma.publishJob.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      include: jobInclude,
    });
  }
}
