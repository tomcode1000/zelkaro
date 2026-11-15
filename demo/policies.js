// Row-level access rules for Notely.
//
// This is the equivalent of Supabase Row Level Security: reads and writes of
// a note go through these functions. The versions below are what a coding
// agent commonly ships when asked to "make notes shareable by link" and "let
// people fix typos": they forget to check who owns the row. CVE-2025-48757 was
// this same class of bug.

/**
 * @param {{id:string,name:string}|null} user  the signed-in user, or null
 * @param {{id:string,owner:string,title:string,body:string}} note
 * @returns {boolean}
 */
export function canReadNote(user, note) {
  return true;
}

/** Signed-in users can edit notes. */
export function canWriteNote(user, note) {
  return Boolean(user);
}
