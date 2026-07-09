import type { CampaignStatus, PrismaClient, Prisma } from "@prisma/client";

const listInclude = {
  creator: true,
  _count: { select: { sourceVideos: true, clips: true } },
} satisfies Prisma.CampaignInclude;

export type CampaignWithRelations = Prisma.CampaignGetPayload<{ include: typeof listInclude }>;

export class CampaignRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list(filter?: { status?: CampaignStatus }) {
    return this.prisma.campaign.findMany({
      where: filter?.status ? { status: filter.status } : undefined,
      include: listInclude,
      orderBy: { createdAt: "desc" },
    });
  }

  byId(id: string) {
    return this.prisma.campaign.findUnique({
      where: { id },
      include: listInclude,
    });
  }

  create(data: Prisma.CampaignUncheckedCreateInput) {
    return this.prisma.campaign.create({ data, include: listInclude });
  }

  update(id: string, data: Prisma.CampaignUncheckedUpdateInput) {
    return this.prisma.campaign.update({ where: { id }, data, include: listInclude });
  }
}
