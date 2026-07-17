import { getPrisma } from "@clipfactory/db";
import type { CategoryDto } from "../contracts/category.js";

/**
 * Central registry of content categories. The registry is only the list of
 * valid options; the authoritative value on each account/video/clip is still the
 * `category` string (routing matches by string), so a rename must cascade those
 * columns. `list()` lazily backfills the registry from whatever categories are
 * already in use, so existing data shows up without a seed step.
 */
export class CategoryService {
  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  /** Distinct non-null category strings currently used by accounts/videos/clips. */
  private async namesInUse(): Promise<string[]> {
    const prisma = getPrisma();
    const [accounts, videos, clips] = await Promise.all([
      prisma.socialAccount.findMany({ distinct: ["category"], select: { category: true } }),
      prisma.sourceVideo.findMany({ where: { category: { not: null } }, distinct: ["category"], select: { category: true } }),
      prisma.clip.findMany({ where: { category: { not: null } }, distinct: ["category"], select: { category: true } }),
    ]);
    const names = new Set<string>();
    for (const r of [...accounts, ...videos, ...clips]) if (r.category) names.add(r.category);
    return [...names];
  }

  async list(): Promise<CategoryDto[]> {
    const prisma = getPrisma();
    // Backfill: make sure every in-use category exists as an option.
    const inUse = await this.namesInUse();
    if (inUse.length > 0) {
      await prisma.category.createMany({
        data: inUse.map((name) => ({ name })),
        skipDuplicates: true,
      });
    }

    const [rows, accountGroups, clipGroups] = await Promise.all([
      prisma.category.findMany({ orderBy: { name: "asc" } }),
      prisma.socialAccount.groupBy({ by: ["category"], _count: { _all: true } }),
      prisma.clip.groupBy({ by: ["category"], _count: { _all: true } }),
    ]);
    const accountCounts = new Map(accountGroups.map((g) => [g.category, g._count._all]));
    const clipCounts = new Map(clipGroups.map((g) => [g.category ?? "", g._count._all]));

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      persona: r.persona,
      accountCount: accountCounts.get(r.name) ?? 0,
      clipCount: clipCounts.get(r.name) ?? 0,
    }));
  }

  async create(rawName: string): Promise<{ id: string; name: string }> {
    const name = this.normalize(rawName);
    const prisma = getPrisma();
    const row = await prisma.category.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    return { id: row.id, name: row.name };
  }

  /**
   * Rename a category and cascade the string to every account/video/clip using
   * it. If the target name already exists, the two merge (entities repoint, the
   * old registry row is dropped).
   */
  async rename(id: string, rawName: string): Promise<{ id: string; name: string }> {
    const prisma = getPrisma();
    const current = await prisma.category.findUnique({ where: { id } });
    if (!current) throw new Error("category not found");
    const next = this.normalize(rawName);
    if (next === current.name) return { id: current.id, name: current.name };

    const existingTarget = await prisma.category.findUnique({ where: { name: next } });

    const cascade = [
      prisma.socialAccount.updateMany({ where: { category: current.name }, data: { category: next } }),
      prisma.sourceVideo.updateMany({ where: { category: current.name }, data: { category: next } }),
      prisma.clip.updateMany({ where: { category: current.name }, data: { category: next } }),
    ];

    if (existingTarget) {
      // Merge into the existing option: repoint entities, drop the old row.
      await prisma.$transaction([...cascade, prisma.category.delete({ where: { id } })]);
      return { id: existingTarget.id, name: existingTarget.name };
    }
    await prisma.$transaction([...cascade, prisma.category.update({ where: { id }, data: { name: next } })]);
    return { id, name: next };
  }

  /**
   * Set the commentary persona for a category (null/blank clears it back to
   * the default). Looked up by name at render time, so it takes effect on the
   * next render — nothing to cascade.
   */
  async setPersona(id: string, persona: string | null): Promise<{ id: string; persona: string | null }> {
    const prisma = getPrisma();
    const value = persona?.trim() || null;
    const row = await prisma.category.update({ where: { id }, data: { persona: value } });
    return { id: row.id, persona: row.persona };
  }

  /** Remove the option only; existing account/clip assignments keep their string. */
  async remove(id: string): Promise<{ removed: true }> {
    const prisma = getPrisma();
    await prisma.category.delete({ where: { id } });
    return { removed: true };
  }
}
