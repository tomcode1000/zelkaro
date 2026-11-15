// Row-level access rules for Notely.
//
// This is the equivalent of Supabase Row Level Security: every read of a
// note goes through canReadNote(). The version below is what a coding agent
// commonly ships when asked to "make notes shareable by link": it forgets to
// check who owns the row. CVE-2025-48757 was this same class of bug.

/**
 * @param {{id:string,name:string}|null} user  the signed-in user, or null
 * @param {{id:string,owner:string,title:string,body:string}} note
 * @returns {boolean}
 */
export function canReadNote(user, note) {
  return true;
}
