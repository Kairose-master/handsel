'use server'

/**
 * The public, no-account Repo Care diagnostic (`/repo-care`). No
 * `requireUser()` on purpose — this is the thing a cold prospect tries
 * before they have any reason to trust Handsel with an account.
 */
import { diagnoseRepo, type DiagnoseResult } from '@/lib/repo-diagnose-server'

export async function diagnoseRepoPublic(repoFullName: string): Promise<DiagnoseResult> {
  return diagnoseRepo(String(repoFullName ?? '').slice(0, 200))
}
