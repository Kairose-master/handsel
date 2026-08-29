'use server'

/**
 * The autonomy console, from the dashboard. Read-only on purpose: this
 * surface answers "what is running by itself and what did it do", and every
 * switch it reports stays where it is governed — the office Automaton and
 * lineage mandate on /office, the gas pool and auto-mine on their own
 * surfaces. An overview that could also flip things would become a second
 * place to change a fact that decides whether money moves.
 */
import { getSession } from '@/lib/get-session'
import { buildAutonomyView } from '@/lib/autonomy-console-server'
// The type comes from the pure module, not from here: a 'use server' file
// turns a re-exported type into a runtime reference
// (tests/server-action-type-reexport).
import type { AutonomyView } from '@/lib/autonomy-console'

export async function myAutonomy(): Promise<AutonomyView> {
  const session = await getSession()
  if (!session?.user) throw new Error('Unauthorized')
  return buildAutonomyView(session.user.id)
}
