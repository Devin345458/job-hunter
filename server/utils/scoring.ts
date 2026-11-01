// Owned by capability A (matching). Learning (capability D) calls rescoreJobs after rules
// change, so the next queue reflects them without a new Claude call per job.
export async function rescoreJobs(jobIds: number[] | 'open', reason: 'rescore' | 'rule_change'): Promise<{ rescored: number }> {
  void jobIds
  void reason
  return { rescored: 0 }
}
