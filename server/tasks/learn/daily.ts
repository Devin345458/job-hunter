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
      const tidy = await tidyFactQuestions(log)
      const learned = await runDailyLearning(log)
      return {
        ...learned,
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
