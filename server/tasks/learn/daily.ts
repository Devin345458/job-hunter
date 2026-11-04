// Runs first in the daily chain. Merges duplicate fact questions and answers the ones the
// knowledge base already answers (before any new question is asked), then rebuilds every learned
// rule from every approve and reject, maps new rejection notes with Claude (once per note), asks
// the questions the pipeline needs, and rescores open jobs so today's queue reflects what Devin
// taught it yesterday.
export default defineTask({
  meta: {
    name: 'learn:daily',
    description: 'Turn decisions and answers into learned rules and rescore',
  },
  async run({ payload }) {
    const outcome = await withRun('learn:daily', triggerOf(payload), async (log) => {
      // Once after the deploy: files his skill and experience answers by what the subject is
      // (Docker under Skills, fintech under Experience) and carries each answer to the same
      // subject asked the other way.
      const sections = refileSubjectSectionsOnce(log)
      // Once after the deploy: labels the skips made before reasons were recorded, and gives every
      // subject one open or answered question again.
      const repair = repairQuestionSkipsOnce(log)
      const tidy = await tidyFactQuestions(log)
      const released = await releaseMisreadFactFields(log)
      const learned = await runDailyLearning(log)
      return {
        ...learned,
        ...(sections.ran ? { sectionEntriesMoved: sections.entries.length, sectionQuestionsRefiled: sections.questions.length, sectionAnswersCarried: sections.answered.length } : {}),
        ...(repair.ran ? { skipRepairLabeled: repair.labeled.length, skipRepairMerged: repair.merged.length, skipRepairReopened: repair.reopened.length } : {}),
        misreadFieldsReleased: released.length,
        factQuestionsMerged: tidy.merged.length,
        factQuestionsAnswered: tidy.derived.length,
        factQuestionsReworded: tidy.reworded.length,
        factKnowledgeWritten: tidy.knowledgeWritten,
        factApplicationsRefreshed: tidy.refreshed.length,
        ...(tidy.semanticError ? { factSemanticCheckError: tidy.semanticError } : {}),
      }
    })
    return { result: outcome }
  },
})
