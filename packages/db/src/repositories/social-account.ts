import type { PrismaClient, Prisma } from "@prisma/client";

export class SocialAccountRepository {
  constructor(private readonly prisma: PrismaClient) {}

  list() {
    return this.prisma.socialAccount.findMany({
      include: { _count: { select: { publishJobs: true } } },
      orderBy: { createdAt: "asc" },
    });
  }

  byId(id: string) {
    return this.prisma.socialAccount.findUnique({ where: { id } });
  }

  byIds(ids: string[]) {
    return this.prisma.socialAccount.findMany({ where: { id: { in: ids } } });
  }

  create(data: Prisma.SocialAccountUncheckedCreateInput) {
    return this.prisma.socialAccount.create({ data });
  }

  update(id: string, data: Prisma.SocialAccountUncheckedUpdateInput) {
    return this.prisma.socialAccount.update({ where: { id }, data });
  }
}
