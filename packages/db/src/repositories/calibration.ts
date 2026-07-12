import type { PrismaClient, Prisma } from "@prisma/client";

const ID = "default";

export class CalibrationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  get() {
    return this.prisma.calibration.findUnique({ where: { id: ID } });
  }

  upsert(data: { weights: Prisma.InputJsonValue; sampleSize: number; insights: Prisma.InputJsonValue }) {
    return this.prisma.calibration.upsert({
      where: { id: ID },
      create: { id: ID, ...data },
      update: data,
    });
  }
}
