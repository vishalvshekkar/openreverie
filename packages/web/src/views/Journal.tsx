import type { JSX } from 'react'

/*
 * The journal destination. This plan owns only that it exists in the nav and
 * where it sits; everything it contains belongs to the journal spec, which
 * replaces this file. Until then it says plainly that the feature is not
 * finished rather than showing an empty list that implies there is nothing
 * written yet.
 */
export function Journal(): JSX.Element {
  return (
    <div className="journal">
      <h2>Journal</h2>
      <p>Journal mode is not finished yet. Nothing is written here.</p>
      <p>When it ships, the entries you write in journal mode will be listed here, newest first.</p>
    </div>
  )
}
