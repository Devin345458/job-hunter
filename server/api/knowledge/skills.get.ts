import { skillCatalogView, type SkillCatalogItem } from '~~/server/utils/skill-catalog'

// GET /api/knowledge/skills
// The skill catalog (server/utils/skill-catalog.ts) for the Knowledge base page: every skill
// employers ask about, core skills first, then the most asked. Empty until the approved catalog
// has been applied.
export default defineEventHandler((): SkillCatalogItem[] => skillCatalogView())
