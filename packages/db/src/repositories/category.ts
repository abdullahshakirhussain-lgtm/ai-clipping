import type { PrismaClient } from "@prisma/client";

export class CategoryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /** Registry lookup by the exact category string stored on clips/accounts. */
  byName(name: string) {
    return this.prisma.category.findUnique({ where: { name } });
  }
}
