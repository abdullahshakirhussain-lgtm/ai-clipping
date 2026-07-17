import { z } from "zod";

/** A category in the central registry, with how many things reference it. */
export const CategoryDtoSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Commentary character for this niche; null = default roast baseline. */
  persona: z.string().nullable(),
  accountCount: z.number().int(),
  clipCount: z.number().int(),
});
export type CategoryDto = z.infer<typeof CategoryDtoSchema>;

/** Set (or clear, with null/empty) a category's commentary persona. */
export const SetPersonaInputSchema = z.object({
  persona: z.string().max(500).nullable(),
});
export type SetPersonaInput = z.infer<typeof SetPersonaInputSchema>;

/** Names are normalised (trimmed + lowercased) so routing string-matches hold. */
export const CategoryNameSchema = z
  .string()
  .min(1)
  .max(60)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => s.length > 0, "name required");

export const CreateCategoryInputSchema = z.object({ name: CategoryNameSchema });
export type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;

export const RenameCategoryInputSchema = z.object({ name: CategoryNameSchema });
export type RenameCategoryInput = z.infer<typeof RenameCategoryInputSchema>;
