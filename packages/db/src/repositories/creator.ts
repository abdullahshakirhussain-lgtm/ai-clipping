import type { PrismaClient, Prisma } from "@prisma/client";

export class CreatorRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list() {
    return this.prisma.creator.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { campaigns: true } } },
    });
  }

  byId(id: string) {
    return this.prisma.creator.findUnique({ where: { id } });
  }

  byHandle(handle: string) {
    return this.prisma.creator.findUnique({ where: { handle } });
  }

  create(data: Prisma.CreatorCreateInput) {
    return this.prisma.creator.create({ data });
  }
}
